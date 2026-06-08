import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { voiceName } from '@/lib/constants';
import { Radius, Spacing, useTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';

function Dot({ index, color }: { index: number; color: string }) {
  const t = useSharedValue(0);

  useEffect(() => {
    t.value = withDelay(
      index * 160,
      withRepeat(
        withSequence(
          withTiming(1, { duration: 320, easing: Easing.out(Easing.quad) }),
          withTiming(0, { duration: 320, easing: Easing.in(Easing.quad) }),
        ),
        -1,
        false,
      ),
    );
    return () => cancelAnimation(t);
  }, [index, t]);

  const style = useAnimatedStyle(() => ({
    opacity: 0.35 + t.value * 0.65,
    transform: [{ translateY: -t.value * 4 }],
  }));

  return <Animated.View style={[styles.dot, { backgroundColor: color }, style]} />;
}

/**
 * Brief "Marie is thinking" animation shown during the processing phase of a
 * turn (spec §3.3 step 6). Rendered as a small Marie-side bubble.
 */
export function ThinkingIndicator() {
  const { colors } = useTheme();
  const personaName = voiceName(useAppStore((s) => s.settings.voice));

  return (
    <View style={styles.row}>
      <View
        style={[styles.bubble, { backgroundColor: colors.marieBubble }]}
        accessibilityRole="text"
        accessibilityLabel={`${personaName} is thinking`}>
        {[0, 1, 2].map((i) => (
          <Dot key={i} index={i} color={colors.textSecondary} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'flex-start', marginVertical: Spacing.xs },
  bubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderRadius: Radius.lg,
    borderBottomLeftRadius: Radius.sm,
  },
  dot: { width: 8, height: 8, borderRadius: Radius.pill },
});
