/**
 * One-shot "you hit today's streak" celebration (spec: streaks relax the
 * no-gamification rule). Fires the moment today's 10-minute practice goal is met
 * mid-session — so the streak feels earned in the moment, not silently on the next
 * app open. Shown once per day (guarded in kv via the streak engine).
 *
 * Renders nothing until `pendingStreakCelebration` is set; dismiss clears it.
 */
import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';
import { useRouter } from 'expo-router';

import { flameTierFor } from '@/lib/streak';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';

const BURNING_FLAME = require('../../assets/images/burning flame.gif');

/** A short, streak-length-aware line of praise. */
function praiseFor(streak: number): string {
  if (streak <= 1) return 'Your first flame is lit. See you tomorrow.';
  if (streak < 7) return 'You showed up again. That’s how French sticks.';
  if (streak < 14) return 'A whole week of speaking. Keep it rolling.';
  if (streak < 30) return 'Unstoppable. This is what fluency feels like.';
  return 'A supernova streak. You’re a different speaker now.';
}

export function StreakCelebration() {
  const { colors } = useTheme();
  const router = useRouter();
  const streak = useAppStore((s) => s.pendingStreakCelebration);
  const dismiss = useAppStore((s) => s.setPendingStreakCelebration);

  useEffect(() => {
    if (streak != null && Platform.OS !== 'web' && useAppStore.getState().settings.haptics) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }, [streak]);

  if (streak == null) return null;

  const tier = flameTierFor(Math.max(1, streak));
  const close = () => dismiss(null);

  return (
    <Animated.View
      entering={FadeIn.duration(220)}
      exiting={FadeOut.duration(160)}
      style={[styles.backdrop, { backgroundColor: colors.scrim }]}>
      <Animated.View
        entering={ZoomIn.springify().damping(16)}
        style={[styles.card, { backgroundColor: colors.surface }]}>
        <View style={[styles.flameDisc, { borderColor: tier.color }]}>
          <ExpoImage source={BURNING_FLAME} style={styles.flame} contentFit="contain" autoplay />
        </View>
        <Text style={[styles.day, { color: tier.color }]}>Day {streak}</Text>
        <Text style={[styles.headline, { color: colors.text }]}>
          {streak === 1 ? 'Streak started!' : 'Streak extended!'}
        </Text>
        <Text style={[styles.sub, { color: colors.textSecondary }]}>{praiseFor(streak)}</Text>

        <Pressable
          onPress={close}
          accessibilityRole="button"
          style={[styles.cta, { backgroundColor: colors.accent }]}>
          <Text style={[styles.ctaText, { color: colors.onAccent }]}>Keep practising</Text>
        </Pressable>
        <Pressable
          onPress={() => {
            close();
            router.push('/streak' as never);
          }}
          accessibilityRole="button"
          hitSlop={8}
          style={styles.link}>
          <Text style={[styles.linkText, { color: colors.textSecondary }]}>See your streak</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.textSecondary} />
        </Pressable>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.lg,
    zIndex: 50,
  },
  card: {
    alignSelf: 'stretch',
    alignItems: 'center',
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    gap: Spacing.xs,
  },
  flameDisc: {
    width: 128,
    height: 128,
    borderRadius: Radius.pill,
    backgroundColor: '#FFFFFF',
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.sm,
  },
  flame: { width: 104, height: 104 },
  day: { fontSize: 44, fontWeight: '800', lineHeight: 48 },
  headline: { fontSize: FontSize.bubble, fontWeight: '700' },
  sub: {
    fontSize: FontSize.body,
    textAlign: 'center',
    lineHeight: FontSize.body * 1.4,
    marginTop: Spacing.xs,
    marginBottom: Spacing.md,
  },
  cta: {
    alignSelf: 'stretch',
    paddingVertical: Spacing.md + 2,
    borderRadius: Radius.pill,
    alignItems: 'center',
  },
  ctaText: { fontSize: FontSize.body, fontWeight: '700' },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingVertical: Spacing.sm,
  },
  linkText: { fontSize: FontSize.caption, fontWeight: '600' },
});
