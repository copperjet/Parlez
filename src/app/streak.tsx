import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { loadDailyActivity } from '@/lib/db/sessions';
import {
  FLAME_TIERS,
  addDays,
  completedDays,
  flameTierFor,
  guaranteeProgress,
  nextFlameTier,
  reconcileStreak,
  todayLocal,
} from '@/lib/streak';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';

const SUB_URL =
  Platform.OS === 'ios'
    ? 'https://apps.apple.com/account/subscriptions'
    : 'https://play.google.com/store/account/subscriptions?package=com.denny32.parlez';

/** Animated flame for an active streak — "let it burn" (transparent GIF). */
const BURNING_FLAME = require('../../assets/images/burning flame.gif');

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Longest run of consecutive complete days anywhere in history (the record). */
function longestRun(completed: Set<string>): number {
  const dates = [...completed].sort();
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const d of dates) {
    if (prev && addDays(prev, 1) === d) run += 1;
    else run = 1;
    if (run > best) best = run;
    prev = d;
  }
  return best;
}

/** A pure motivational line keyed to the streak length. */
function blurbFor(streak: number): string {
  if (streak <= 0) return 'Practice 10 minutes today to light your first flame.';
  if (streak < 3) return 'A habit is forming — keep it lit.';
  if (streak < 7) return 'You’re building real momentum.';
  if (streak < 14) return 'A whole week of French. Incredible.';
  if (streak < 30) return 'Unstoppable. This is how fluency is built.';
  return 'A supernova streak. You’re a different speaker now.';
}

export default function Streak() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const streak = useAppStore((s) => s.streakCount);
  const lastSessionDate = useAppStore((s) => s.lastSessionDate);
  const firstLaunchDate = useAppStore((s) => s.firstLaunchDate);
  const isFirstTimeUser = useAppStore((s) => s.isFirstTimeUser);

  const [activity, setActivity] = useState<{ date: string; seconds: number }[]>([]);
  const [monthOffset, setMonthOffset] = useState(0);

  useEffect(() => {
    loadDailyActivity().then(setActivity);
  }, []);

  const today = todayLocal();
  const completed = useMemo(() => completedDays(activity), [activity]);

  // Recompute from the activity ledger so a lapsed day shows here even when the
  // store still holds a stale pre-lapse count — but reconcile against the stored
  // streak so a short ledger (e.g. just after a reinstall, before it rebuilds)
  // can't under-report a still-alive synced streak. Matches refreshStreakFromHistory
  // exactly. Falls back to the store value until the ledger has loaded (or on web).
  const streakNow =
    activity.length > 0
      ? reconcileStreak(completed, today, streak, lastSessionDate).streak
      : streak;
  const record = useMemo(() => Math.max(streakNow, longestRun(completed)), [completed, streakNow]);

  const tier = flameTierFor(Math.max(1, streakNow));
  const next = nextFlameTier(streakNow);

  const guarantee = useMemo(
    () => guaranteeProgress(completed, firstLaunchDate, today),
    [completed, firstLaunchDate, today],
  );

  // ── Calendar grid for the displayed month ──────────────────────────────────
  const cal = useMemo(() => {
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const year = base.getFullYear();
    const month = base.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    // JS getDay(): 0=Sun..6=Sat → shift so Monday is column 0.
    const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
    const cells: ({ day: number; iso: string } | null)[] = [];
    for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
    for (let d = 1; d <= daysInMonth; d += 1) {
      const iso = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ day: d, iso });
    }
    return { label: `${MONTHS[month]} ${year}`, cells };
  }, [monthOffset]);

  const onRefund = () => {
    void WebBrowser.openBrowserAsync(SUB_URL);
  };

  const flameDim = streakNow <= 0;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <Text style={[styles.title, { color: colors.text }]}>Your streak</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.textSecondary} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + Spacing.xxl }]}
        showsVerticalScrollIndicator={false}>
        {/* ── Hero ─────────────────────────────────────────────────────────── */}
        <Animated.View
          entering={FadeInDown.duration(420).springify().damping(18)}
          style={[
            styles.hero,
            { backgroundColor: colors.surface, borderColor: colors.border },
          ]}>
          {/* Flame art sits on a white disc in both modes — reads as a warm glow
              rather than a stray box. An active streak gets the animated flame so
              it literally burns; a cold streak shows a dimmed static ember. */}
          <View style={[styles.flameWrap, !flameDim && { borderColor: colors.accent }]}>
            {flameDim ? (
              <Image
                source={tier.image}
                style={[styles.flame, { opacity: 0.35 }]}
                resizeMode="contain"
              />
            ) : (
              <ExpoImage
                source={BURNING_FLAME}
                style={styles.flame}
                contentFit="contain"
                autoplay
              />
            )}
          </View>
          <Text style={[styles.count, { color: colors.accent }]}>{streakNow}</Text>
          <Text style={[styles.countLabel, { color: colors.text }]}>
            {streakNow === 1 ? 'day in a row' : 'days in a row'}
          </Text>
          <Text style={[styles.blurb, { color: colors.textSecondary }]}>{blurbFor(streakNow)}</Text>

          {/* Tier milestone track — the earned milestones (orange is the start). */}
          <View style={styles.track}>
            {FLAME_TIERS.filter((t) => t.minStreak > 1).map((t, i) => {
              const reached = streakNow >= t.minStreak;
              return (
                <View key={t.id} style={styles.trackStep}>
                  {i > 0 ? (
                    <View
                      style={[
                        styles.trackLine,
                        { backgroundColor: reached ? tier.color : colors.border },
                      ]}
                    />
                  ) : null}
                  <View
                    style={[
                      styles.trackDot,
                      {
                        backgroundColor: reached ? t.color : colors.surfaceMuted,
                        borderColor: reached ? t.color : colors.border,
                      },
                    ]}>
                    <Text
                      style={[
                        styles.trackDotText,
                        { color: reached ? '#FFFFFF' : colors.textFaint },
                      ]}>
                      {t.minStreak}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
          {next ? (
            <Text style={[styles.nextHint, { color: colors.textFaint }]}>
              {next.minStreak - streakNow} more{' '}
              {next.minStreak - streakNow === 1 ? 'day' : 'days'} to “{next.label}”.
            </Text>
          ) : (
            <Text style={[styles.nextHint, { color: colors.textFaint }]}>
              You’ve reached the hottest flame. 🔵
            </Text>
          )}
        </Animated.View>

        {/* ── Record ───────────────────────────────────────────────────────── */}
        <View style={[styles.recordRow, { backgroundColor: colors.surfaceMuted }]}>
          <Ionicons name="heart" size={18} color={colors.error} />
          <Text style={[styles.recordText, { color: colors.text }]}>
            Your record: {record} {record === 1 ? 'day' : 'days'}
          </Text>
        </View>

        {/* ── Calendar ─────────────────────────────────────────────────────── */}
        <View style={styles.calHeader}>
          <Text style={[styles.section, { color: colors.text }]}>Your month</Text>
          <View style={styles.calNav}>
            <Pressable onPress={() => setMonthOffset((m) => m - 1)} hitSlop={10}
              accessibilityRole="button" accessibilityLabel="Previous month">
              <Ionicons name="chevron-back" size={20} color={colors.textSecondary} />
            </Pressable>
            <Text style={[styles.calMonth, { color: colors.textSecondary }]}>{cal.label}</Text>
            <Pressable
              onPress={() => setMonthOffset((m) => Math.min(0, m + 1))}
              disabled={monthOffset >= 0}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Next month">
              <Ionicons
                name="chevron-forward"
                size={20}
                color={monthOffset >= 0 ? colors.textFaint : colors.textSecondary}
              />
            </Pressable>
          </View>
        </View>

        <View style={[styles.calCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.weekRow}>
            {WEEKDAYS.map((w) => (
              <Text key={w} style={[styles.weekday, { color: colors.textFaint }]}>
                {w}
              </Text>
            ))}
          </View>
          <View style={styles.grid}>
            {cal.cells.map((cell, i) => {
              if (!cell) return <View key={`e${i}`} style={styles.cell} />;
              const isToday = cell.iso === today;
              const done = completed.has(cell.iso);
              const future = cell.iso > today;
              return (
                <View key={cell.iso} style={styles.cell}>
                  <View
                    style={[
                      styles.dayDot,
                      done && { backgroundColor: colors.accent },
                      isToday && !done && { borderWidth: 2, borderColor: colors.accent },
                      !done && !isToday && { backgroundColor: colors.surfaceMuted },
                    ]}>
                    {done && isToday ? (
                      <Ionicons name="flame" size={17} color="#FFFFFF" />
                    ) : done ? (
                      <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                    ) : isToday ? (
                      <Ionicons name="flame-outline" size={17} color={colors.accent} />
                    ) : (
                      <Text
                        style={[
                          styles.dayNum,
                          { color: future ? colors.textFaint : colors.textSecondary },
                        ]}>
                        {cell.day}
                      </Text>
                    )}
                  </View>
                </View>
              );
            })}
          </View>
        </View>

        {/* ── Money-back guarantee (first-time users only) ─────────────────── */}
        {isFirstTimeUser && (guarantee.windowOpen || guarantee.eligible) ? (
          <View
            style={[
              styles.guarantee,
              {
                backgroundColor: guarantee.eligible ? colors.accentSoft : colors.surface,
                borderColor: guarantee.eligible ? colors.accent : colors.border,
              },
            ]}>
            <View style={styles.guaranteeTop}>
              <Ionicons
                name={guarantee.eligible ? 'shield-checkmark' : 'shield-outline'}
                size={22}
                color={colors.accent}
              />
              <Text style={[styles.guaranteeTitle, { color: colors.text }]}>
                {guarantee.eligible
                  ? 'You qualify for the money-back guarantee'
                  : '30-day money-back guarantee'}
              </Text>
            </View>
            <Text style={[styles.guaranteeBody, { color: colors.textSecondary }]}>
              {guarantee.eligible
                ? 'You practised 20 days in a row. If Parlez isn’t for you, you can request a full refund — no questions.'
                : `Practise 10 minutes a day for ${guarantee.needed} days in a row to qualify for a full refund.`}
            </Text>

            <View style={[styles.barTrack, { backgroundColor: colors.surfaceMuted }]}>
              <View
                style={[
                  styles.barFill,
                  {
                    backgroundColor: colors.accent,
                    width: `${Math.min(100, (guarantee.bestRun / guarantee.needed) * 100)}%`,
                  },
                ]}
              />
            </View>
            <View style={styles.guaranteeMeta}>
              <Text style={[styles.guaranteeMetaText, { color: colors.textSecondary }]}>
                {guarantee.bestRun}/{guarantee.needed} days
              </Text>
              {!guarantee.eligible ? (
                <Text style={[styles.guaranteeMetaText, { color: colors.textFaint }]}>
                  {guarantee.daysLeft} {guarantee.daysLeft === 1 ? 'day' : 'days'} left
                </Text>
              ) : null}
            </View>

            {guarantee.eligible ? (
              <Pressable
                onPress={onRefund}
                accessibilityRole="button"
                style={[styles.refundBtn, { borderColor: colors.accent }]}>
                <Text style={[styles.refundText, { color: colors.accent }]}>Request a refund</Text>
                <Ionicons name="open-outline" size={16} color={colors.accent} />
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <Pressable
          onPress={() => router.push('/conversation' as never)}
          accessibilityRole="button"
          style={[styles.cta, { backgroundColor: colors.accent }]}>
          <Text style={[styles.ctaText, { color: colors.onAccent }]}>Keep practising</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  title: { fontSize: FontSize.title, fontWeight: '700' },
  body: { paddingHorizontal: Spacing.lg, gap: Spacing.lg },

  hero: {
    borderRadius: Radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.xs,
  },
  flameWrap: {
    width: 132,
    height: 132,
    borderRadius: Radius.pill,
    backgroundColor: '#FFFFFF',
    borderWidth: 3,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  flame: { width: 112, height: 112 },
  count: { fontSize: 56, fontWeight: '800', lineHeight: 60 },
  countLabel: { fontSize: FontSize.body, fontWeight: '600' },
  blurb: {
    fontSize: FontSize.body,
    textAlign: 'center',
    lineHeight: FontSize.body * 1.4,
    marginTop: Spacing.xs,
  },

  track: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: Spacing.md,
    alignSelf: 'stretch',
  },
  trackStep: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  trackLine: { flex: 1, height: 3, borderRadius: 2 },
  trackDot: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trackDotText: { fontSize: FontSize.caption, fontWeight: '700' },
  nextHint: { fontSize: FontSize.caption, textAlign: 'center', marginTop: Spacing.sm },

  recordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderRadius: Radius.lg,
  },
  recordText: { fontSize: FontSize.body, fontWeight: '600' },

  calHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  section: { fontSize: FontSize.body, fontWeight: '700' },
  calNav: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  calMonth: { fontSize: FontSize.caption, fontWeight: '600', minWidth: 96, textAlign: 'center' },

  calCard: {
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  weekRow: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '600' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' },
  dayDot: {
    width: 34,
    height: 34,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayNum: { fontSize: FontSize.caption, fontWeight: '600' },

  guarantee: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  guaranteeTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  guaranteeTitle: { fontSize: FontSize.bubble, fontWeight: '700', flex: 1 },
  guaranteeBody: { fontSize: FontSize.body, lineHeight: FontSize.body * 1.4 },
  barTrack: { height: 10, borderRadius: Radius.pill, overflow: 'hidden', marginTop: Spacing.xs },
  barFill: { height: 10, borderRadius: Radius.pill },
  guaranteeMeta: { flexDirection: 'row', justifyContent: 'space-between' },
  guaranteeMetaText: { fontSize: FontSize.caption, fontWeight: '600' },
  refundBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingVertical: Spacing.md,
    marginTop: Spacing.xs,
  },
  refundText: { fontSize: FontSize.body, fontWeight: '700' },

  cta: {
    paddingVertical: Spacing.md + 2,
    borderRadius: Radius.pill,
    alignItems: 'center',
  },
  ctaText: { fontSize: FontSize.body, fontWeight: '700' },
});
