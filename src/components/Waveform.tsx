import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Radius, useTheme } from '@/lib/theme';

export type WaveformMode = 'idle' | 'marie' | 'user';

const BAR_COUNT = 7;
const REST = 0.16;

/** A per-bar peak so the wave looks organic rather than a flat block. */
function barPeak(index: number): number {
  return 0.45 + 0.5 * Math.abs(Math.sin((index + 1) * 1.1));
}

function Bar({
  index,
  mode,
  level,
  color,
}: {
  index: number;
  mode: WaveformMode;
  level: number;
  color: string;
}) {
  const fill = useSharedValue(REST);

  useEffect(() => {
    cancelAnimation(fill);
    if (mode === 'marie') {
      const peak = barPeak(index);
      fill.value = withDelay(
        index * 75,
        withRepeat(
          withTiming(peak, { duration: 420, easing: Easing.inOut(Easing.quad) }),
          -1,
          true,
        ),
      );
    } else if (mode === 'idle') {
      fill.value = withTiming(REST, { duration: 220 });
    }
    return () => cancelAnimation(fill);
  }, [mode, index, fill]);

  useEffect(() => {
    if (mode === 'user') {
      const wobble = 0.7 + 0.3 * Math.abs(Math.sin((index + 1) * 0.9));
      const target = Math.max(REST, Math.min(1, level * wobble));
      fill.value = withTiming(target, { duration: 110 });
    }
  }, [level, mode, index, fill]);

  const style = useAnimatedStyle(() => ({
    height: `${fill.value * 100}%`,
  }));

  return <Animated.View style={[styles.bar, { backgroundColor: color }, style]} />;
}

/**
 * Visual feedback for who is talking (spec §4.1): animated while Marie speaks,
 * amplitude-driven while the user speaks, quiet when neither is.
 */
export function Waveform({ mode, level = 0 }: { mode: WaveformMode; level?: number }) {
  const { colors } = useTheme();
  const color = mode === 'idle' ? colors.waveformMuted : colors.waveform;

  return (
    <View style={styles.container} accessibilityElementsHidden importantForAccessibility="no">
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <Bar key={i} index={i} mode={mode} level={level} color={color} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  bar: {
    width: 5,
    borderRadius: Radius.pill,
    minHeight: 5,
  },
});
