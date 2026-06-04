import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MARIE_VOICES, type MarieVoiceId, type SpeechSpeed } from '@/lib/constants';
import { clearProfile } from '@/lib/db/profile';
import { clearMessages, saveProfileSummary, saveSettings } from '@/lib/db/sessions';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import type { Settings as AppSettings } from '@/lib/types';
import { useAppStore } from '@/stores/appStore';

const SPEEDS: { id: SpeechSpeed; label: string }[] = [
  { id: 'slow', label: 'Slow' },
  { id: 'normal', label: 'Normal' },
  { id: 'fast', label: 'Fast' },
];

const SENSITIVITY: { id: 'auto' | 'manual'; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'manual', label: 'Manual' },
];

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.segment, { backgroundColor: colors.surfaceMuted }]}>
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <Pressable
            key={opt.id}
            onPress={() => onChange(opt.id)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[
              styles.segmentItem,
              active && { backgroundColor: colors.accent },
            ]}>
            <Text
              style={{
                color: active ? colors.onAccent : colors.textSecondary,
                fontWeight: active ? '700' : '500',
                fontSize: FontSize.caption,
              }}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.row, { borderBottomColor: colors.border }]}>
      <Text style={[styles.rowLabel, { color: colors.text }]}>{label}</Text>
      {children}
    </View>
  );
}

/** Settings (spec §4.5). Only what the spec lists — nothing else belongs here. */
export default function Settings() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const resetMemory = useAppStore((s) => s.resetMemory);

  const change = (patch: Partial<AppSettings>) => {
    updateSettings(patch);
    void saveSettings(useAppStore.getState().settings);
  };

  const confirmClear = () => {
    Alert.alert(
      'Clear session history?',
      'Marie will forget your past conversations and start fresh. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            resetMemory();
            void clearMessages();
            void clearProfile();
            void saveProfileSummary('');
            router.back();
          },
        },
      ],
    );
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <Text style={[styles.title, { color: colors.text }]}>Settings</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close settings"
          hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.textSecondary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Row label="Speech speed">
          <Segmented
            options={SPEEDS}
            value={settings.speechSpeed}
            onChange={(speechSpeed) => change({ speechSpeed })}
          />
        </Row>

        <Row label="Marie’s voice">
          <Segmented
            options={MARIE_VOICES.map((v) => ({ id: v.id, label: v.label }))}
            value={settings.voice}
            onChange={(voice: MarieVoiceId) => change({ voice })}
          />
        </Row>

        <Row label="Microphone sensitivity">
          <Segmented
            options={SENSITIVITY}
            value={settings.micSensitivity}
            onChange={(micSensitivity) => change({ micSensitivity })}
          />
        </Row>

        <Row label="Haptic feedback">
          <Switch
            value={settings.haptics}
            onValueChange={(haptics) => change({ haptics })}
            trackColor={{ true: colors.accent, false: colors.border }}
          />
        </Row>

        <Pressable
          onPress={() => router.push('/account')}
          accessibilityRole="button"
          style={[styles.linkRow, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Account</Text>
          <View style={styles.linkRight}>
            <Text style={{ color: colors.textSecondary, fontSize: FontSize.caption }}>
              Sign in to sync
            </Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </View>
        </Pressable>

        <Pressable
          onPress={() => router.push('/privacy')}
          accessibilityRole="button"
          style={[styles.linkRow, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Privacy</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
        </Pressable>

        <Pressable
          onPress={confirmClear}
          accessibilityRole="button"
          style={styles.clearRow}>
          <Text style={[styles.clearText, { color: colors.error }]}>
            Clear session history
          </Text>
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
  body: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xxl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    paddingVertical: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: { fontSize: FontSize.body, fontWeight: '500', flexShrink: 1 },
  segment: {
    flexDirection: 'row',
    borderRadius: Radius.pill,
    padding: 3,
    gap: 3,
  },
  segmentItem: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.pill,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  linkRight: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs },
  clearRow: { paddingVertical: Spacing.xl, alignItems: 'center' },
  clearText: { fontSize: FontSize.body, fontWeight: '600' },
});
