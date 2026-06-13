import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  VOICE_BY_GENDER,
  genderOfVoice,
  voiceName,
  type SpeechSpeed,
  type VoiceGender,
} from '@/lib/constants';
import { clearProfile } from '@/lib/db/profile';
import {
  clearMessages,
  clearStructuredProfile,
  saveProfileSummary,
  saveSettings,
  saveTurnsSinceConsolidation,
} from '@/lib/db/sessions';
import { FontSize, Radius, Spacing, THEME_OPTIONS, useTheme } from '@/lib/theme';
import type { ChatThemeId, Settings as AppSettings } from '@/lib/types';
import { useAppStore } from '@/stores/appStore';
import { useAuthStore } from '@/stores/authStore';
import { planSummary, useSubscriptionStore } from '@/stores/subscriptionStore';

const SPEEDS: { id: SpeechSpeed; label: string }[] = [
  { id: 'slow', label: 'Slow' },
  { id: 'normal', label: 'Normal' },
  { id: 'fast', label: 'Fast' },
];

const SENSITIVITY: { id: 'auto' | 'manual'; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'manual', label: 'Manual' },
];

const VOICE_GENDERS: { id: VoiceGender; label: string }[] = [
  { id: 'female', label: 'Female' },
  { id: 'male', label: 'Male' },
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
  const streakCount = useAppStore((s) => s.streakCount);
  const isPremium = useSubscriptionStore((s) => s.isPremium);
  const isTrialing = useSubscriptionStore((s) => s.isTrialing);
  const tier = useSubscriptionStore((s) => s.tier);

  const isSignedIn = useAuthStore((s) => s.isSignedIn);
  const email = useAuthStore((s) => s.email);

  // Right-side label for the Account row: reacts live to sign-in and plan.
  // Premium shows the plan even when signed out — subscription management
  // lives in Account, and entitlement doesn't require sign-in.
  const accountStatus = isPremium
    ? planSummary({ isPremium, isTrialing, tier })
    : !isSignedIn
      ? 'Sign in to sync'
      : (email ?? 'Synced');

  const onUpgrade = () => {
    router.push('/paywall' as never);
  };

  const change = (patch: Partial<AppSettings>) => {
    updateSettings(patch);
    void saveSettings(useAppStore.getState().settings);
  };

  const confirmClear = () => {
    Alert.alert(
      'Clear session history?',
      `${voiceName(settings.voice)} will forget your past conversations and start fresh. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            resetMemory();
            void clearMessages();
            void clearProfile();
            void clearStructuredProfile();
            void saveProfileSummary('');
            void saveTurnsSinceConsolidation(0);
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
        <Pressable
          onPress={() => router.push('/streak' as never)}
          accessibilityRole="button"
          style={[styles.linkRow, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Streak</Text>
          <View style={styles.linkRight}>
            <Text style={[styles.streakValue, { color: colors.text }]}>
              {streakCount > 0 ? `${streakCount} ${streakCount === 1 ? 'day' : 'days'}` : '—'}
            </Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </View>
        </Pressable>

        <View style={[styles.themeBlock, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Chat theme</Text>
          <View style={styles.swatches}>
            {THEME_OPTIONS.map((t) => {
              const active = t.id === settings.chatTheme;
              return (
                <Pressable
                  key={t.id}
                  onPress={() => change({ chatTheme: t.id as ChatThemeId })}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.label} theme`}
                  accessibilityState={{ selected: active }}
                  hitSlop={6}
                  style={styles.swatchCol}>
                  <View
                    style={[
                      styles.swatch,
                      { backgroundColor: t.swatch, borderColor: colors.background },
                      active && { borderColor: colors.text },
                    ]}>
                    {active ? <Ionicons name="checkmark" size={16} color="#FFFFFF" /> : null}
                  </View>
                  <Text
                    style={[
                      styles.swatchLabel,
                      { color: active ? colors.text : colors.textSecondary },
                    ]}>
                    {t.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Row label="Speech speed">
          <Segmented
            options={SPEEDS}
            value={settings.speechSpeed}
            onChange={(speechSpeed) => change({ speechSpeed })}
          />
        </Row>

        <Row label="Voice">
          <Segmented
            options={VOICE_GENDERS}
            value={genderOfVoice(settings.voice)}
            onChange={(gender: VoiceGender) => change({ voice: VOICE_BY_GENDER[gender] })}
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
          onPress={() => router.push('/progress' as never)}
          accessibilityRole="button"
          style={[styles.linkRow, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Your progress</Text>
          <View style={styles.linkRight}>
            <Text style={{ color: colors.textSecondary, fontSize: FontSize.caption }}>
              Corrections & patterns
            </Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </View>
        </Pressable>

        <Pressable
          onPress={() => router.push('/account')}
          accessibilityRole="button"
          style={[styles.linkRow, { borderBottomColor: colors.border }]}>
          <Text style={[styles.rowLabel, { color: colors.text }]}>Account</Text>
          <View style={styles.linkRight}>
            <Text
              numberOfLines={1}
              style={[styles.linkValue, { color: colors.textSecondary }]}>
              {accountStatus}
            </Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </View>
        </Pressable>

        {!isPremium && !isTrialing ? (
          <Pressable
            onPress={onUpgrade}
            accessibilityRole="button"
            style={[styles.linkRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.rowLabel, { color: colors.accent }]}>Upgrade to Parlez Premium</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.accent} />
          </Pressable>
        ) : null}

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
  linkRight: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, flexShrink: 1 },
  linkValue: { fontSize: FontSize.caption, flexShrink: 1, maxWidth: 200, textAlign: 'right' },
  clearRow: { paddingVertical: Spacing.xl, alignItems: 'center' },
  clearText: { fontSize: FontSize.body, fontWeight: '600' },
  streakValue: { fontSize: FontSize.body, fontWeight: '600' },
  themeBlock: {
    paddingVertical: Spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.md,
  },
  swatches: { flexDirection: 'row', justifyContent: 'space-between' },
  swatchCol: { alignItems: 'center', gap: Spacing.xs, flex: 1 },
  swatch: {
    width: 36,
    height: 36,
    borderRadius: Radius.pill,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchLabel: { fontSize: FontSize.caption, fontWeight: '600' },
});
