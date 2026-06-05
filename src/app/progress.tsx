import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CorrectionCard } from '@/components';
import { loadCorrections } from '@/lib/db/sessions';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import type { Correction } from '@/lib/types';
import { useAppStore } from '@/stores/appStore';

/**
 * Progress / review (spec §5 follow-up). A calm place to see what's been
 * practised: the corrections collected so far and the recurring patterns the
 * partner has noticed. Read-only — the live conversation stays the main screen.
 */
export default function Progress() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const profileSummary = useAppStore((s) => s.profileSummary);
  const messages = useAppStore((s) => s.messages);
  const priorHistory = useAppStore((s) => s.priorHistory);

  // Persisted corrections (native). On web nothing is persisted, so fall back to
  // the in-memory transcript of this and the prior session.
  const [persisted, setPersisted] = useState<Correction[]>([]);
  useEffect(() => {
    loadCorrections().then(setPersisted);
  }, []);

  const corrections = useMemo(() => {
    if (persisted.length) return persisted;
    return [...priorHistory, ...messages].flatMap((m) => m.corrections ?? []);
  }, [persisted, priorHistory, messages]);

  const patterns = useMemo(
    () =>
      profileSummary
        .split('\n')
        .map((l) => l.replace(/^[-•]\s*/, '').trim())
        .filter(Boolean),
    [profileSummary],
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <Text style={[styles.title, { color: colors.text }]}>Your progress</Text>
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
          A quiet look at what you've practised. Nothing here is a grade — just
          gentle reminders of what to keep working on.
        </Text>

        <Text style={[styles.section, { color: colors.text }]}>Patterns to practise</Text>
        {patterns.length ? (
          <View style={[styles.card, { backgroundColor: colors.surfaceMuted }]}>
            {patterns.map((p, i) => (
              <View key={i} style={styles.patternRow}>
                <Text style={[styles.bullet, { color: colors.accent }]}>•</Text>
                <Text style={[styles.patternText, { color: colors.text }]}>{p}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={[styles.empty, { color: colors.textFaint }]}>
            Keep chatting — patterns will appear here as you talk more.
          </Text>
        )}

        <Text style={[styles.section, { color: colors.text }]}>
          Corrections{corrections.length ? ` (${corrections.length})` : ''}
        </Text>
        {corrections.length ? (
          corrections.map((c, i) => <CorrectionCard key={i} correction={c} />)
        ) : (
          <Text style={[styles.empty, { color: colors.textFaint }]}>
            No corrections yet. They'll collect here as you speak.
          </Text>
        )}
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
  body: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.xxl, gap: Spacing.sm },
  lead: { fontSize: FontSize.body, lineHeight: FontSize.body * 1.45, marginBottom: Spacing.sm },
  section: {
    fontSize: FontSize.body,
    fontWeight: '700',
    marginTop: Spacing.lg,
    marginBottom: Spacing.xs,
  },
  card: { borderRadius: Radius.md, padding: Spacing.md, gap: Spacing.sm },
  patternRow: { flexDirection: 'row', gap: Spacing.sm },
  bullet: { fontSize: FontSize.body, fontWeight: '700' },
  patternText: { fontSize: FontSize.body, flex: 1, lineHeight: FontSize.body * 1.4 },
  empty: { fontSize: FontSize.caption, fontStyle: 'italic', paddingVertical: Spacing.sm },
});
