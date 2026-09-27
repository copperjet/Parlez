/**
 * Partner dashboard (modal) — only reachable for accounts designated as a
 * creator or educator (Settings shows the entry by role). Creators see their
 * funnel, earnings and payouts; educators see the same funnel for their
 * students, no money. Referee identities are never shown — conversions are
 * date · plan · amount only.
 */
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { voiceName } from '@/lib/constants';
import {
  fetchCreatorDashboard,
  type CreatorConversion,
  type CreatorDashboard,
} from '@/lib/services/supabaseService';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';

const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.denny32.parlez';

type LoadState = CreatorDashboard | 'loading' | 'signed_out' | 'not_partner' | 'error';

const usd = (n: number) => `$${n.toFixed(2)}`;

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

const planLabel = (plan: string | null) =>
  plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : 'Plan';

const STATUS_LABEL: Record<CreatorConversion['status'], string> = {
  pending: 'Pending',
  eligible: 'Available',
  refunded: 'Refunded',
};

export default function Creator() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const personaName = voiceName(useAppStore((s) => s.settings.voice));

  const [state, setState] = useState<LoadState>('loading');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const res = await fetchCreatorDashboard();
    setState(res === null ? 'error' : res);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const share = async (code: string) => {
    const link = `${PLAY_URL}&referrer=${encodeURIComponent(`referral_code=${code}`)}`;
    try {
      await Share.share({
        message:
          `Have your first French conversation — my code ${code} gives you ` +
          `double the free time with ${personaName} on Parlez. ${link}`,
      });
    } catch {
      // Sheet dismissed / unavailable — nothing to do.
    }
  };

  const statusColor = (s: CreatorConversion['status']) =>
    s === 'eligible' ? colors.success : s === 'refunded' ? colors.error : colors.textSecondary;

  const dash = typeof state === 'object' ? state : null;
  const isCreator = dash?.role === 'creator';
  const title = dash?.role === 'educator' ? 'Educator dashboard' : 'Creator dashboard';

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close dashboard"
          hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.textSecondary} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + Spacing.xxl }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
        }>
        {state === 'loading' ? (
          <ActivityIndicator style={styles.spinner} color={colors.accent} />
        ) : null}

        {state === 'signed_out' ? (
          <View style={styles.message}>
            <Text style={[styles.lead, { color: colors.textSecondary }]}>
              Sign in to see your dashboard.
            </Text>
            <Pressable
              onPress={() => router.push('/account')}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.primary,
                { backgroundColor: colors.accent, opacity: pressed ? 0.7 : 1 },
              ]}>
              <Text style={[styles.primaryText, { color: colors.onAccent }]}>Go to Account</Text>
            </Pressable>
          </View>
        ) : null}

        {state === 'not_partner' ? (
          <Text style={[styles.lead, { color: colors.textSecondary }]}>
            This account isn’t set up as a creator or educator. If you think that’s a
            mistake, get in touch with the Parlez team.
          </Text>
        ) : null}

        {state === 'error' ? (
          <Text style={[styles.lead, { color: colors.textSecondary }]}>
            Couldn’t load your dashboard — check your connection and pull down to retry.
          </Text>
        ) : null}

        {dash ? (
          <>
            {dash.label ? (
              <Text style={[styles.lead, { color: colors.textSecondary }]}>{dash.label}</Text>
            ) : null}

            <View
              style={[
                styles.codeCard,
                { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
              ]}>
              <Text style={[styles.cardLabel, { color: colors.textSecondary }]}>Your code</Text>
              <Text
                selectable
                accessibilityLabel={`Code ${dash.code}`}
                style={[styles.code, { color: colors.text }]}>
                {dash.code}
              </Text>
            </View>

            <Pressable
              onPress={() => share(dash.code)}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.primary,
                { backgroundColor: colors.accent, opacity: pressed ? 0.7 : 1 },
              ]}>
              <Text style={[styles.primaryText, { color: colors.onAccent }]}>Share your code</Text>
            </Pressable>

            <View style={styles.statsRow}>
              <Stat
                value={dash.funnel.joined}
                label={isCreator ? 'joined' : 'students joined'}
              />
              <Stat value={dash.funnel.activated} label={isCreator ? 'speaking' : 'practising'} />
              <Stat value={dash.funnel.purchased} label="subscribed" />
            </View>

            {isCreator && dash.earnings ? (
              <View
                style={[
                  styles.card,
                  { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
                ]}>
                <Text style={[styles.cardLabel, { color: colors.textSecondary }]}>
                  Available to pay out
                </Text>
                <Text style={[styles.bigMoney, { color: colors.text }]}>
                  {usd(dash.earnings.availableUsd)}
                </Text>
                <View style={[styles.divider, { backgroundColor: colors.border }]} />
                <View style={styles.moneyRow}>
                  <Text style={[styles.moneyLabel, { color: colors.textSecondary }]}>
                    Pending · clears after {dash.earnings.holdbackDays} days
                  </Text>
                  <Text style={[styles.moneyValue, { color: colors.text }]}>
                    {usd(dash.earnings.pendingUsd)}
                  </Text>
                </View>
                <View style={styles.moneyRow}>
                  <Text style={[styles.moneyLabel, { color: colors.textSecondary }]}>
                    Paid to date
                  </Text>
                  <Text style={[styles.moneyValue, { color: colors.text }]}>
                    {usd(dash.earnings.paidUsd)}
                  </Text>
                </View>
                <Text style={[styles.footnote, { color: colors.textFaint }]}>
                  You earn {Math.round(dash.earnings.rate * 100)}% of each new subscriber’s
                  first payment. Paid monthly once your available balance reaches{' '}
                  {usd(dash.earnings.minPayoutUsd)}.
                </Text>
              </View>
            ) : null}

            <Text style={[styles.section, { color: colors.text }]}>
              {isCreator ? 'Recent sales' : 'Recent subscriptions'}
            </Text>
            {dash.conversions.length ? (
              <View
                style={[
                  styles.card,
                  { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
                ]}>
                {dash.conversions.map((c, i) => (
                  <View
                    key={`${c.purchasedAt}-${i}`}
                    style={[
                      styles.listRow,
                      i > 0 && {
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderTopColor: colors.border,
                      },
                    ]}>
                    <Text style={[styles.listMain, { color: colors.text }]}>
                      {shortDate(c.purchasedAt)} · {planLabel(c.plan)}
                    </Text>
                    <View style={styles.listRight}>
                      {isCreator ? (
                        <Text
                          style={[
                            styles.listAmount,
                            {
                              color: colors.text,
                              textDecorationLine: c.status === 'refunded' ? 'line-through' : 'none',
                            },
                          ]}>
                          {c.commissionUsd == null ? '—' : usd(c.commissionUsd)}
                        </Text>
                      ) : null}
                      <Text style={[styles.listStatus, { color: statusColor(c.status) }]}>
                        {isCreator ? STATUS_LABEL[c.status] : c.status === 'refunded' ? 'Refunded' : 'Active'}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <Text style={[styles.empty, { color: colors.textFaint }]}>
                No subscriptions yet. They’ll appear here as people you refer sign up.
              </Text>
            )}

            {isCreator ? (
              <>
                <Text style={[styles.section, { color: colors.text }]}>Payouts</Text>
                {dash.payouts?.length ? (
                  <View
                    style={[
                      styles.card,
                      { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
                    ]}>
                    {dash.payouts.map((p, i) => (
                      <View
                        key={`${p.paidAt}-${i}`}
                        style={[
                          styles.listRow,
                          i > 0 && {
                            borderTopWidth: StyleSheet.hairlineWidth,
                            borderTopColor: colors.border,
                          },
                        ]}>
                        <Text style={[styles.listMain, { color: colors.text }]}>
                          {shortDate(p.paidAt)}
                          {p.method ? ` · ${p.method}` : ''}
                        </Text>
                        <Text style={[styles.listAmount, { color: colors.text }]}>
                          {usd(p.amountUsd)}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={[styles.empty, { color: colors.textFaint }]}>
                    No payouts yet.
                  </Text>
                )}
              </>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
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
  body: { paddingHorizontal: Spacing.lg, gap: Spacing.lg },
  lead: { fontSize: FontSize.body, lineHeight: FontSize.body * 1.45 },
  spinner: { marginTop: Spacing.xl },
  message: { gap: Spacing.lg },
  codeCard: {
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.xl,
    gap: Spacing.xs,
  },
  cardLabel: { fontSize: FontSize.caption, fontWeight: '600' },
  code: { fontSize: 34, fontWeight: '800', letterSpacing: 4 },
  primary: {
    borderRadius: Radius.pill,
    paddingVertical: Spacing.md + 2,
    alignItems: 'center',
  },
  primaryText: { fontSize: FontSize.body, fontWeight: '700' },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: Spacing.sm,
  },
  stat: { alignItems: 'center', gap: 2 },
  statValue: { fontSize: FontSize.title, fontWeight: '700' },
  statLabel: { fontSize: FontSize.caption },
  card: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  bigMoney: { fontSize: 36, fontWeight: '800' },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: Spacing.xs },
  moneyRow: { flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.md },
  moneyLabel: { fontSize: FontSize.caption, flexShrink: 1 },
  moneyValue: { fontSize: FontSize.body, fontWeight: '600' },
  footnote: {
    fontSize: FontSize.caption,
    lineHeight: FontSize.caption * 1.4,
    marginTop: Spacing.xs,
  },
  section: { fontSize: FontSize.body, fontWeight: '700', marginBottom: -Spacing.sm },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.sm,
    gap: Spacing.md,
  },
  listMain: { fontSize: FontSize.body, flexShrink: 1 },
  listRight: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  listAmount: { fontSize: FontSize.body, fontWeight: '600' },
  listStatus: { fontSize: FontSize.caption, fontWeight: '600', minWidth: 64, textAlign: 'right' },
  empty: { fontSize: FontSize.caption, fontStyle: 'italic' },
});
