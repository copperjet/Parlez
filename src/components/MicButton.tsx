import { Ionicons } from '@expo/vector-icons';
import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import type { TurnState } from '@/lib/types';
import { Radius, useTheme } from '@/lib/theme';

const SIZE = 84;

/**
 * The large central mic button (spec §4.1, §6.3). Tap to speak, tap to stop,
 * tap to interrupt Marie. Auto-activation and timing are owned by the turn loop;
 * this component only reflects state and reports taps.
 */
export function MicButton({
  turnState,
  onPress,
  onLongPress,
}: {
  turnState: TurnState;
  onPress: () => void;
  /** Long-press reveals the text-input fallback (spec §4.4). */
  onLongPress?: () => void;
}) {
  const { colors } = useTheme();

  const active = turnState === 'listening' || turnState === 'recording';
  const interruptible = turnState === 'marie_speaking';
  const pending = turnState === 'processing';
  // Grace is non-pressable but visually "about to activate", not dead.
  const disabled = turnState === 'grace' || pending;

  const ring = useSharedValue(0);
  const press = useSharedValue(1);

  useEffect(() => {
    cancelAnimation(ring);
    if (active) {
      ring.value = 0;
      ring.value = withRepeat(
        withTiming(1, { duration: 1400, easing: Easing.out(Easing.ease) }),
        -1,
        false,
      );
    } else {
      ring.value = withTiming(0, { duration: 200 });
    }
    return () => cancelAnimation(ring);
  }, [active, ring]);

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + ring.value * 0.6 }],
    opacity: (1 - ring.value) * 0.45,
  }));
  const buttonStyle = useAnimatedStyle(() => ({ transform: [{ scale: press.value }] }));

  const bg = pending
    ? colors.waveformMuted
    : interruptible
      ? colors.surfaceMuted
      : colors.accent;
  const iconColor = interruptible ? colors.textSecondary : colors.onAccent;
  const iconName = turnState === 'recording' ? 'stop' : 'mic';

  const label = interruptible
    ? 'Tap to interrupt Marie'
    : turnState === 'recording'
      ? 'Stop recording'
      : 'Speak';

  return (
    <View style={styles.wrap}>
      {active ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.ring, { backgroundColor: colors.accent }, ringStyle]}
        />
      ) : null}
      <Animated.View style={buttonStyle}>
        <Pressable
          onPress={onPress}
          onLongPress={onLongPress}
          delayLongPress={450}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint="Long-press to type instead"
          accessibilityState={{ disabled, busy: turnState === 'processing' }}
          onPressIn={() => {
            press.value = withTiming(0.92, { duration: 90 });
          }}
          onPressOut={() => {
            press.value = withTiming(1, { duration: 120 });
          }}
          style={[
            styles.button,
            {
              backgroundColor: bg,
              borderColor: interruptible ? colors.border : 'transparent',
            },
          ]}>
          <Ionicons name={iconName} size={34} color={iconColor} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute',
    width: SIZE,
    height: SIZE,
    borderRadius: Radius.pill,
  },
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: Radius.pill,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
