import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';

/**
 * The conversation screen's only chrome (spec §4.1): Marie's name + avatar on the
 * left, a settings icon on the right. Nothing else ever goes here.
 */
export function MarieHeader({ onSettingsPress }: { onSettingsPress: () => void }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.bar,
        {
          paddingTop: insets.top + Spacing.sm,
          backgroundColor: colors.background,
          borderBottomColor: colors.border,
        },
      ]}>
      <View style={styles.identity}>
        <View style={[styles.avatar, { backgroundColor: colors.accent }]}>
          <Text style={[styles.avatarLetter, { color: colors.onAccent }]}>M</Text>
        </View>
        <Text style={[styles.name, { color: colors.text }]}>Marie</Text>
      </View>

      <Pressable
        onPress={onSettingsPress}
        accessibilityRole="button"
        accessibilityLabel="Settings"
        hitSlop={12}
        style={({ pressed }) => [styles.settings, pressed && { opacity: 0.5 }]}>
        <Ionicons name="settings-outline" size={24} color={colors.textSecondary} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  identity: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: { fontSize: FontSize.body, fontWeight: '700' },
  name: { fontSize: FontSize.title, fontWeight: '600' },
  settings: { padding: Spacing.xs },
});
