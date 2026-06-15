import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  BackHandler,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CorrectionCard,
  MarieHeader,
  MicButton,
  SignInNudge,
  SpeechBubble,
  ThinkingIndicator,
  Waveform,
  type WaveformMode,
} from '@/components';
import { useCanConverse } from '@/components/PaywallGate';
import { MIC_OFF_NOTICE, voiceName } from '@/lib/constants';
import { addDailyActivity } from '@/lib/db/sessions';
import { creditFreeTasteStreakDay, refreshStreakFromHistory, todayLocal } from '@/lib/streak';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { useNetwork } from '@/lib/useNetwork';
import { useTurnEngine } from '@/lib/turnStateMachine';
import type { Message, TurnState } from '@/lib/types';
import { useAppStore } from '@/stores/appStore';
import { useSubscriptionStore } from '@/stores/subscriptionStore';

function waveformModeFor(turnState: TurnState): WaveformMode {
  if (turnState === 'marie_speaking') return 'marie';
  if (turnState === 'listening' || turnState === 'recording') return 'user';
  return 'idle';
}

function MessageRow({
  message,
  onReplay,
}: {
  message: Message;
  /** Omitted in the read-only locked view — no replay button is shown. */
  onReplay?: (text: string) => void;
}) {
  return (
    <View>
      <SpeechBubble
        speaker={message.speaker}
        text={message.text}
        translation={message.translation}
        segments={message.segments}
        faint={message.pending}
        onReplay={
          message.speaker === 'marie' && onReplay ? () => onReplay(message.text) : undefined
        }
      />
      {message.corrections?.map((c, i) => (
        <CorrectionCard key={`${message.id}-c${i}`} correction={c} />
      ))}
    </View>
  );
}

/**
 * One conversation session. Hosts the turn engine — remounting it (via the
 * sessionEpoch key) cleanly restarts the conversation after a memory reset.
 */
function ConversationSession() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const online = useNetwork();

  const messages = useAppStore((s) => s.messages);
  const turnState = useAppStore((s) => s.turnState);
  const liveTranscript = useAppStore((s) => s.liveTranscript);
  const errorNotice = useAppStore((s) => s.errorNotice);
  const setErrorNotice = useAppStore((s) => s.setErrorNotice);

  const { micLevel, onMicPress, submitText, sttUnavailable, replay } = useTurnEngine(online);
  const personaName = voiceName(useAppStore((s) => s.settings.voice));

  const [textMode, setTextMode] = useState(false);
  const [draft, setDraft] = useState('');

  // No native speech recognizer (Expo Go / web): converse by typing. Keep the
  // text input open so the mic is never a dead-end.
  useEffect(() => {
    if (sttUnavailable) setTextMode(true);
  }, [sttUnavailable]);

  const listRef = useRef<FlatList<Message>>(null);
  // Auto-scroll only when the user is already pinned to the bottom. Without this
  // gate, every content-size change (a reply landing, the pending bubble growing,
  // a re-measure on app re-open) yanked the list back to the end — so the user
  // could never scroll up to read history, and re-opening the app snapped/glitched
  // to the latest message. We track whether they're near the bottom and respect it.
  const atBottomRef = useRef(true);
  const didInitialScrollRef = useRef(false);
  const scrollToEnd = useCallback(() => {
    // First settle on open is instant (no animated jump → no re-open glitch);
    // subsequent appends animate, but only while the user is pinned to the bottom.
    if (!atBottomRef.current && didInitialScrollRef.current) return;
    const animated = didInitialScrollRef.current;
    didInitialScrollRef.current = true;
    listRef.current?.scrollToEnd({ animated });
  }, []);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const distanceFromBottom =
        contentSize.height - (contentOffset.y + layoutMeasurement.height);
      atBottomRef.current = distanceFromBottom < 80;
    },
    [],
  );

  const renderItem = useCallback(
    ({ item }: { item: Message }) => <MessageRow message={item} onReplay={replay} />,
    [replay],
  );

  const waveMode = useMemo(() => waveformModeFor(turnState), [turnState]);

  // Android: pressing back during a conversation confirms first (spec §9.2).
  // Focus-scoped: when a modal (settings/account/…) is on top this screen is
  // unfocused, so back there pops the modal instead of prompting to end.
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        Alert.alert('End conversation?', `${personaName} will be here when you come back.`, [
          { text: 'Stay', style: 'cancel' },
          { text: 'End', style: 'destructive', onPress: () => BackHandler.exitApp() },
        ]);
        return true;
      });
      return () => sub.remove();
    }, [personaName]),
  );

  // Bank real in-conversation time toward the daily streak (spec: 10 min/day).
  // A char-estimate of speech under-counts genuine practice — it ignores listening
  // and thinking time — so the streak measures actual wall-clock presence in a live
  // session instead. Foreground-only and idle-gated: a backgrounded screen or an
  // abandoned-but-open conversation accrues no credit.
  useEffect(() => {
    const TICK_MS = 20_000; // bank presence every 20s
    const MAX_DELTA_MS = 60_000; // cap one interval (missed timer / brief blur)
    const IDLE_CUTOFF_MS = 90_000; // pause after this long with no turn activity
    let lastTickAt = Date.now();
    let lastActiveAt = Date.now();

    // Any turn-state change means the user is engaged — refresh the activity clock.
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.turnState !== prev.turnState) lastActiveAt = Date.now();
    });

    const tick = () => {
      const now = Date.now();
      const engaged =
        AppState.currentState === 'active' && now - lastActiveAt < IDLE_CUTOFF_MS;
      const deltaSecs = Math.round(Math.min(now - lastTickAt, MAX_DELTA_MS) / 1000);
      lastTickAt = now;
      if (engaged && deltaSecs > 0) {
        void addDailyActivity(todayLocal(), deltaSecs).then(() => refreshStreakFromHistory());
      }
    };

    const id = setInterval(tick, TICK_MS);
    // Don't credit time spent backgrounded; restart the clock on resume.
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') lastTickAt = Date.now();
    });

    return () => {
      clearInterval(id);
      appSub.remove();
      unsub();
    };
  }, []);

  const sendDraft = () => {
    const text = draft.trim();
    if (!text) return;
    submitText(text);
    setDraft('');
    if (!sttUnavailable) setTextMode(false);
  };

  const banner =
    errorNotice ??
    (sttUnavailable
      ? `Voice needs the full Parlez app — type to chat with ${personaName} here.`
      : null) ??
    (!online ? 'You’re offline — full conversation needs internet.' : null);
  const bannerIsError = errorNotice != null;
  // The mic-permission notice is actionable: tapping it jumps straight to the OS
  // app-settings page so the user can grant access without hunting for it.
  const bannerIsMicPrompt = errorNotice === MIC_OFF_NOTICE;
  const onBannerPress = () => {
    if (bannerIsMicPrompt) {
      void Linking.openSettings();
      return;
    }
    if (bannerIsError) setErrorNotice(null);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <MarieHeader
        onSettingsPress={() => router.push('/settings')}
        onStreakPress={() => router.push('/streak' as never)}
      />

      <SignInNudge />

      {banner ? (
        <Pressable
          onPress={onBannerPress}
          accessibilityRole={bannerIsError ? 'button' : 'text'}
          style={[
            styles.banner,
            {
              backgroundColor: bannerIsError ? colors.warningBg : colors.accentSoft,
              borderBottomColor: bannerIsError ? colors.warningBorder : colors.accent,
            },
          ]}>
          <Text
            style={[
              styles.bannerText,
              {
                color: bannerIsError ? colors.warningText : colors.accent,
                fontWeight: '600',
              },
            ]}>
            {banner}
          </Text>
        </Pressable>
      ) : null}

      <KeyboardAvoidingView
        style={styles.listFlex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          onContentSizeChange={scrollToEnd}
          onScroll={onScroll}
          scrollEventThrottle={64}
          style={styles.listFlex}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={turnState === 'processing' ? <ThinkingIndicator /> : null}
        />

        {liveTranscript ? (
          <Text style={[styles.live, { color: colors.textFaint }]} numberOfLines={2}>
            {liveTranscript}
          </Text>
        ) : null}

        <View
          style={[
            styles.dock,
            { borderTopColor: colors.border, paddingBottom: insets.bottom + Spacing.md },
          ]}>
          {textMode ? (
          <View style={styles.textRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Type in French…"
              placeholderTextColor={colors.textFaint}
              style={[
                styles.textInput,
                { backgroundColor: colors.surfaceMuted, color: colors.text },
              ]}
              autoFocus
              onSubmitEditing={sendDraft}
              returnKeyType="send"
              accessibilityLabel="Type your response"
            />
            <Pressable
              onPress={sendDraft}
              accessibilityRole="button"
              accessibilityLabel="Send"
              style={[styles.sendBtn, { backgroundColor: colors.accent }]}>
              <Ionicons name="arrow-up" size={22} color={colors.onAccent} />
            </Pressable>
            {sttUnavailable ? null : (
              <Pressable
                onPress={() => setTextMode(false)}
                accessibilityRole="button"
                accessibilityLabel="Close text input"
                hitSlop={10}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            )}
          </View>
        ) : (
          <Waveform mode={waveMode} level={micLevel} />
        )}
          <MicButton
            turnState={sttUnavailable ? 'idle' : turnState}
            onPress={sttUnavailable ? () => setTextMode(true) : onMicPress}
            onLongPress={() => setTextMode(true)}
          />
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

/**
 * Sheet that overlays the conversation when the user has hit their daily cap.
 * Upgrade path is the primary CTA (Hormozi: the cap is the offer).
 */
function CapSheet() {
  const { colors } = useTheme();
  const router = useRouter();
  const capBlocked = useSubscriptionStore((s) => s.capBlocked);
  const tier = useSubscriptionStore((s) => s.capBlockedTier);
  const capSeconds = useSubscriptionStore((s) => s.tierCapSeconds);
  const clear = useSubscriptionStore((s) => s.clearCapBlocked);

  if (!capBlocked || !tier) return null;

  const capMinutes = capSeconds ? Math.round(capSeconds / 60) : 30;
  const headline =
    tier === 'monthly'
      ? `You've used your daily ${capMinutes} minutes.`
      : `You've reached today's ${capMinutes} minute limit.`;
  const sub =
    tier === 'monthly'
      ? 'Annual unlocks 90 minutes a day — three times the practice for less than half the monthly rate.'
      : 'Come back tomorrow, or upgrade to Lifetime for unlimited practice.';
  const ctaLabel = tier === 'monthly' ? 'Upgrade to Annual' : 'See Lifetime';

  return (
    <View style={[capStyles.backdrop, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
      <View style={[capStyles.sheet, { backgroundColor: colors.surface }]}>
        <Text style={[capStyles.title, { color: colors.text }]}>{headline}</Text>
        <Text style={[capStyles.sub, { color: colors.textSecondary }]}>{sub}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={ctaLabel}
          onPress={() => {
            clear();
            router.push(('/paywall?reason=cap') as never);
          }}
          style={[capStyles.cta, { backgroundColor: colors.accent }]}>
          <Text style={[capStyles.ctaText, { color: colors.onAccent }]}>{ctaLabel}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue tomorrow"
          onPress={clear}
          hitSlop={8}
          style={capStyles.dismiss}>
          <Text style={[capStyles.dismissText, { color: colors.textSecondary }]}>
            Continue tomorrow
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Read-only conversation shown once the free taste is spent (and the user isn't
 * subscribed). The history stays on screen — it's the proof of value — but the
 * mic/input is replaced by an upgrade bar. The turn engine is NOT mounted, so a
 * locked user makes no server calls. Tapping the bar opens the paywall.
 */
function LockedConversation() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const messages = useAppStore((s) => s.messages);
  const streakCount = useAppStore((s) => s.streakCount);
  const personaName = voiceName(useAppStore((s) => s.settings.voice));

  const listRef = useRef<FlatList<Message>>(null);
  const renderItem = useCallback(
    ({ item }: { item: Message }) => <MessageRow message={item} />,
    [],
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <MarieHeader
        onSettingsPress={() => router.push('/settings')}
        onStreakPress={() => router.push('/streak' as never)}
      />
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={renderItem}
        // Land on the most recent turn — the read-only history opens where the
        // conversation left off, not scrolled all the way back to the greeting.
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        style={styles.listFlex}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
      />
      <View
        style={[
          styles.lockedDock,
          {
            backgroundColor: colors.background,
            borderTopColor: colors.border,
            paddingBottom: insets.bottom + Spacing.md,
          },
        ]}>
        <Text style={[styles.lockedNote, { color: colors.textSecondary }]}>
          That was your free session with {personaName}.
        </Text>
        <Pressable
          onPress={() => router.push('/paywall?reason=free' as never)}
          accessibilityRole="button"
          accessibilityLabel="Upgrade to keep speaking"
          style={[styles.upgradeBar, { backgroundColor: colors.accent }]}>
          <Ionicons name="flame" size={20} color={colors.onAccent} />
          <Text style={[styles.upgradeText, { color: colors.onAccent }]}>
            {streakCount > 0
              ? `Day ${streakCount} · Upgrade to keep speaking`
              : 'Upgrade to keep speaking'}
          </Text>
          <Ionicons name="arrow-forward" size={18} color={colors.onAccent} />
        </Pressable>
      </View>
    </View>
  );
}

/**
 * The conversation screen — the entire app (spec §4.1). One screen: Marie's
 * header, the scrolling transcript, the waveform, and the mic button.
 *
 * Self-gating: an entitled/trialing user — or one still inside the free taste —
 * gets the full live conversation; once the free taste is spent it flips to the
 * read-only LockedConversation. The flip from chatting → locked fires the
 * celebratory paywall once (they just lit their first flame); a relaunch while
 * already locked lands straight in read-only without a paywall.
 */
export default function Conversation() {
  const sessionEpoch = useAppStore((s) => s.sessionEpoch);
  const { canChat, ready } = useCanConverse();
  const router = useRouter();
  const wasChatting = useRef(false);

  useEffect(() => {
    if (!ready) return;
    if (canChat) {
      wasChatting.current = true;
    } else if (wasChatting.current) {
      // Just crossed the free-taste line in-session — celebrate, then offer.
      wasChatting.current = false;
      // The free taste IS the first 10-min streak day. Light it here — the single
      // chokepoint every exhaustion path funnels through (server 403 or the local
      // meter crossing) — so the streak screen and the paywall's "Day 1" agree.
      // The local ledger can trail the server, which also counts greeting +
      // silence turns the client never banks; this tops today up to the goal.
      void creditFreeTasteStreakDay();
      router.push('/paywall?reason=free' as never);
    }
  }, [canChat, ready, router]);

  if (!ready) return null;
  if (!canChat) return <LockedConversation />;
  return (
    <>
      <ConversationSession key={sessionEpoch} />
      <CapSheet />
    </>
  );
}

const capStyles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  sheet: {
    alignSelf: 'stretch',
    margin: Spacing.lg,
    padding: Spacing.lg,
    borderRadius: Radius.lg,
    gap: Spacing.sm,
  },
  title: { fontSize: FontSize.bubble, fontWeight: '700' },
  sub: { fontSize: FontSize.body, lineHeight: FontSize.body * 1.4 },
  cta: {
    marginTop: Spacing.sm,
    paddingVertical: Spacing.md,
    borderRadius: Radius.pill,
    alignItems: 'center',
  },
  ctaText: { fontSize: FontSize.body, fontWeight: '700' },
  dismiss: { alignItems: 'center', paddingVertical: Spacing.sm },
  dismissText: { fontSize: FontSize.caption, fontWeight: '500' },
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  listFlex: { flex: 1 },
  list: {
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.lg,
  },
  banner: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bannerText: { fontSize: FontSize.caption, textAlign: 'center' },
  live: {
    fontSize: FontSize.caption,
    fontStyle: 'italic',
    textAlign: 'center',
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  dock: {
    alignItems: 'center',
    gap: Spacing.md,
    paddingTop: Spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  textRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    alignSelf: 'stretch',
  },
  textInput: {
    flex: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
    fontSize: FontSize.body,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockedDock: {
    paddingTop: Spacing.md,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  lockedNote: { fontSize: FontSize.caption, textAlign: 'center' },
  upgradeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.lg,
    borderRadius: Radius.pill,
  },
  upgradeText: { fontSize: FontSize.body, fontWeight: '700' },
});
