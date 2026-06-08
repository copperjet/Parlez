import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { clearProfile } from '@/lib/db/profile';
import {
  clearActivity,
  clearMessages,
  clearStreak,
  clearStructuredProfile,
  saveProfileSummary,
} from '@/lib/db/sessions';
import { voiceName } from '@/lib/constants';
import { ENV } from '@/lib/env';
import { FontSize, Spacing, useTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';
import { useSubscriptionStore } from '@/stores/subscriptionStore';

function deleteAccountUrl(): string {
  const base = ENV.supabaseUrl.replace(/\/$/, '');
  return base ? `${base}/functions/v1/delete-account` : 'https://parlez.app/delete-account';
}

const PRINCIPLES = [
  'Your voice audio is never stored. It is transcribed, then immediately discarded.',
  'Parlez contains no third-party advertising SDKs.',
  'Your learning profile is never shared with third parties.',
  'Cloud sync is opt-in. The app is fully functional without an account.',
  'You can delete all of your data at any time, right here.',
  'Parlez is built to be GDPR and CCPA compliant.',
];

/** Privacy policy and data-deletion flow (spec §8, §11.1 P0). */
export default function Privacy() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const resetAll = useAppStore((s) => s.resetAll);
  const personaName = voiceName(useAppStore((s) => s.settings.voice));

  const confirmDelete = () => {
    Alert.alert(
      'Delete all my data?',
      `This permanently removes your conversations, your streak, and everything ${personaName} has learned about you. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete everything',
          style: 'destructive',
          onPress: () => {
            resetAll();
            void clearMessages();
            void clearProfile();
            void clearStructuredProfile();
            void clearStreak();
            void clearActivity();
            void saveProfileSummary('');
            void useSubscriptionStore.getState().logOutAndReset();
            router.back();
          },
        },
      ],
    );
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <Text style={[styles.title, { color: colors.text }]}>Privacy</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.textSecondary} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.lead, { color: colors.textSecondary }]}>
          Parlez is built around one idea — getting you speaking French — and
          collects only what serves that.
        </Text>

        {PRINCIPLES.map((p) => (
          <View key={p} style={styles.principle}>
            <Ionicons
              name="checkmark-circle"
              size={20}
              color={colors.success}
              style={styles.tick}
            />
            <Text style={[styles.principleText, { color: colors.text }]}>{p}</Text>
          </View>
        ))}

        <Pressable
          onPress={confirmDelete}
          accessibilityRole="button"
          style={styles.deleteRow}>
          <Text style={[styles.deleteText, { color: colors.error }]}>
            Delete all my data
          </Text>
        </Pressable>

        <Pressable
          onPress={() => void WebBrowser.openBrowserAsync(deleteAccountUrl())}
          accessibilityRole="button"
          style={styles.webDeleteRow}>
          <Text style={[styles.webDeleteText, { color: colors.textSecondary }]}>
            Also delete my account & subscription on the web
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
  body: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xxl, gap: Spacing.md },
  lead: { fontSize: FontSize.body, lineHeight: FontSize.body * 1.5 },
  principle: { flexDirection: 'row', gap: Spacing.sm, alignItems: 'flex-start' },
  tick: { marginTop: 1 },
  principleText: { flex: 1, fontSize: FontSize.body, lineHeight: FontSize.body * 1.45 },
  deleteRow: { paddingVertical: Spacing.xl, alignItems: 'center' },
  deleteText: { fontSize: FontSize.body, fontWeight: '600' },
  webDeleteRow: { paddingBottom: Spacing.lg, alignItems: 'center' },
  webDeleteText: { fontSize: FontSize.caption, textDecorationLine: 'underline' },
});
