import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { flameTierFor } from '@/lib/streak';
import { useAppStore } from '@/stores/appStore';

/**
 * Compact flame + day-count pill for the conversation header. Taps through to the
 * full streak screen. The flame art follows the current streak tier so it warms
 * up (orange → ember → violet → blue) as the streak grows.
 */
export function StreakChip({ onPress }: { onPress: () => void }) {
  const { colors } = useTheme();
  const streak = useAppStore((s) => s.streakCount);
  const tier = flameTierFor(Math.max(1, streak));

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        streak > 0 ? `Streak: ${streak} ${streak === 1 ? 'day' : 'days'}` : 'Start your streak'
      }
      hitSlop={8}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: colors.surfaceMuted, opacity: pressed ? 0.6 : 1 },
      ]}>
      <View style={styles.flameDisc}>
        <Image source={tier.image} style={styles.flame} resizeMode="contain" />
      </View>
      <Text style={[styles.count, { color: streak > 0 ? colors.text : colors.textSecondary }]}>
        {streak > 0 ? streak : '—'}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingLeft: 2,
    paddingRight: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  flameDisc: {
    width: 26,
    height: 26,
    borderRadius: Radius.pill,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  flame: { width: 22, height: 22 },
  count: { fontSize: FontSize.body, fontWeight: '700' },
});
