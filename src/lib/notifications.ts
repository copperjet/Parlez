/**
 * Local practice-reminder notifications. Local only — the backend has no push
 * tokens, cron, or outbound push path, and all streak state lives in the
 * device's SQLite `daily_activity` table, so server push would buy nothing.
 *
 * Strategy: one-off DATE triggers for a rolling {@link REMINDER_HORIZON_DAYS}
 * window plus at most two "streak at risk" rescues (today / tomorrow, 20:30).
 * Every reconcile point cancels everything and reschedules, so the schedule is
 * always a pure function of (settings, permission, daily activity, streak).
 * A repeating DAILY trigger can't express "skip today once the goal is met" —
 * cancelling one kills the whole series — hence one-offs + reconcile.
 *
 * Fire times use the device's local wall clock; a timezone change drifts them
 * until the next foreground reconcile — the same accepted tradeoff as the
 * streak's day boundary (see `todayLocal()` in `@/lib/streak`).
 *
 * Everything here is best-effort and no-ops on web (expo-notifications is
 * native-only; web is a supported target).
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { PERSONA_NAME } from '@/lib/constants';
import { loadDailyActivity, loadNotifPromptedAt, saveNotifPromptedAt } from '@/lib/db/sessions';
import { addDays, completedDays, todayLocal } from '@/lib/streak';
import { useAppStore } from '@/stores/appStore';

export const REMINDER_CHANNEL_ID = 'practice-reminders';
export const DEFAULT_REMINDER_TIME = '18:00';
/** Rescue fires at 20:30 local — late enough to be urgent, early enough to act. */
const RESCUE_HOUR = 20;
const RESCUE_MINUTE = 30;
/**
 * Days of one-off reminders kept scheduled; any app open refills the window.
 * A user who stays away longer simply stops being nagged — intentional.
 */
const REMINDER_HORIZON_DAYS = 14;

/** English-with-French-flavour copy in Camille's voice, rotated day to day. */
const DAILY_COPY: { title: string; body: string }[] = [
  {
    title: `${PERSONA_NAME} t’attend !`,
    body: 'A few minutes of French keeps it flowing. She’s ready when you are.',
  },
  {
    title: 'Ready for a little French?',
    body: `Ten minutes with ${PERSONA_NAME} today — allez, on y va !`,
  },
  {
    title: 'Your French missed you today',
    body: `${PERSONA_NAME} saved you a seat. Un petit moment ensemble ?`,
  },
];

function rescueCopy(streak: number): { title: string; body: string } {
  return {
    title: `Your ${streak}-day streak ends at midnight`,
    body: `Ten minutes with ${PERSONA_NAME} saves it. Vite, vite !`,
  };
}

/** Parse `'HH:mm'`; anything malformed falls back to the 18:00 default. */
export function parseReminderTime(value: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  const hour = m ? Number(m[1]) : NaN;
  const minute = m ? Number(m[2]) : NaN;
  if (!m || hour > 23 || minute > 59) return { hour: 18, minute: 0 };
  return { hour, minute };
}

/** `YYYY-MM-DD` + hour/minute → a local wall-clock Date. */
function atLocalTime(iso: string, hour: number, minute: number): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, hour, minute, 0, 0);
}

/**
 * Foreground handler + Android channel. Called once per launch, before any
 * scheduling. Reminders are pointless while the user is already in the app,
 * so foreground arrivals are fully suppressed.
 */
export async function initNotifications(): Promise<void> {
  if (Platform.OS === 'web') return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
      name: 'Practice reminders',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }
}

export async function getNotificationPermission(): Promise<
  'granted' | 'denied' | 'undetermined'
> {
  if (Platform.OS === 'web') return 'denied';
  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'granted') return 'granted';
  return status === 'undetermined' ? 'undetermined' : 'denied';
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

/**
 * The one sanctioned unprompted OS-permission ask: right after the user's
 * first completed session (streak-celebration dismiss, or the launch fallback
 * for free-taste users whose celebration is suppressed — see
 * `creditFreeTasteStreakDay`). Self-gating: a kv stamp makes every later call
 * a no-op, and the Settings toggle is the explicit re-entry path.
 */
export async function maybePromptAfterFirstGoal(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    if (!useAppStore.getState().settings.remindersEnabled) return;
    if ((await getNotificationPermission()) !== 'undetermined') return;
    if (await loadNotifPromptedAt()) return;
    await saveNotifPromptedAt(todayLocal());
    await requestNotificationPermission();
    await reconcileReminders();
  } catch {
    // Best-effort — reminders never block the app.
  }
}

/**
 * Launch bootstrap: handler + channel, the fallback first prompt (only once a
 * completed session exists, honouring "ask after the first session" even when
 * the celebration overlay never showed), then a schedule reconcile.
 */
export async function bootstrapNotifications(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    await initNotifications();
    if (useAppStore.getState().streakCount >= 1) await maybePromptAfterFirstGoal();
    await reconcileReminders();
  } catch {
    // Best-effort.
  }
}

/** Notification tap → conversation. Returns the unsubscribe function. */
export function addReminderTapListener(onTap: () => void): () => void {
  if (Platform.OS === 'web') return () => {};
  const sub = Notifications.addNotificationResponseReceivedListener(() => onTap());
  return () => sub.remove();
}

// Concurrent reconcile calls coalesce: the in-flight pass finishes, then one
// trailing pass re-runs against the freshest state. Prevents interleaved
// cancel-all/schedule passes from double-scheduling.
let inFlight: Promise<void> | null = null;
let rerunQueued = false;

/**
 * The single scheduler. Cancel everything (this app schedules nothing but
 * reminders), then rebuild from current state:
 * - daily reminder each day of the horizon at the user's chosen time, skipping
 *   today when the goal is already met or the time has passed;
 * - today's rescue at 20:30 when a streak ≥ 2 is at risk;
 * - tomorrow's rescue when today is done (covers not opening the app
 *   tomorrow; tomorrow's own reconcile replaces it if they do).
 * Idempotent — safe to call from every hook point.
 */
export async function reconcileReminders(): Promise<void> {
  if (Platform.OS === 'web') return;
  if (inFlight) {
    rerunQueued = true;
    return inFlight;
  }
  inFlight = (async () => {
    do {
      rerunQueued = false;
      await reconcileOnce();
    } while (rerunQueued);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function reconcileOnce(): Promise<void> {
  try {
    const { settings, streakCount } = useAppStore.getState();
    if (!settings.remindersEnabled || (await getNotificationPermission()) !== 'granted') {
      await Notifications.cancelAllScheduledNotificationsAsync();
      return;
    }

    const activity = await loadDailyActivity();
    const completed = completedDays(activity);
    const today = todayLocal();
    const todayComplete = completed.has(today);
    const now = new Date();

    await Notifications.cancelAllScheduledNotificationsAsync();

    const { hour, minute } = parseReminderTime(settings.reminderTime);
    for (let i = 0; i < REMINDER_HORIZON_DAYS; i++) {
      const fireAt = atLocalTime(addDays(today, i), hour, minute);
      if (i === 0 && (todayComplete || fireAt <= now)) continue;
      const copy = DAILY_COPY[i % DAILY_COPY.length];
      await Notifications.scheduleNotificationAsync({
        content: { title: copy.title, body: copy.body, data: { url: '/conversation' } },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: fireAt,
          channelId: REMINDER_CHANNEL_ID,
        },
      });
    }

    // Rescue: only today's and tomorrow's evenings can ever matter — by the
    // day after, a missed day has already killed the streak (computeStreak).
    if (streakCount >= 2) {
      const rescueAt = todayComplete
        ? atLocalTime(addDays(today, 1), RESCUE_HOUR, RESCUE_MINUTE)
        : atLocalTime(today, RESCUE_HOUR, RESCUE_MINUTE);
      if (rescueAt > now) {
        const copy = rescueCopy(streakCount);
        await Notifications.scheduleNotificationAsync({
          content: { title: copy.title, body: copy.body, data: { url: '/conversation' } },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: rescueAt,
            channelId: REMINDER_CHANNEL_ID,
          },
        });
      }
    }
  } catch {
    // Best-effort — a failed reconcile self-heals on the next hook point.
  }
}
