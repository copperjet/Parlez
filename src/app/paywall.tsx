/**
 * Paywall — the only thing standing between a fresh install and the
 * conversation. Three tiers (Monthly / Annual / Lifetime); Annual is
 * default-selected. Monthly + Annual carry the 7-day Play-native intro trial.
 *
 * Prices come from `offerings.availablePackages[i].product.priceString` —
 * never hardcoded, so localisation + regional pricing Just Work.
 */
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PurchasesPackage } from 'react-native-purchases';

import { voiceName } from '@/lib/constants';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';
import { useSubscriptionStore } from '@/stores/subscriptionStore';

type TierId = 'monthly' | 'annual' | 'lifetime';

const TERMS_URL = 'https://codarti.com/parlez/terms';
const PRIVACY_URL = 'https://codarti.com/parlez/privacy';

function classify(pkg: PurchasesPackage): TierId | null {
  const type = pkg.packageType;
  if (type === 'MONTHLY') return 'monthly';
  if (type === 'ANNUAL') return 'annual';
  const id = pkg.identifier.toLowerCase();
  const prodId = pkg.product.identifier.toLowerCase();
  if (id.includes('lifetime') || prodId.includes('lifetime')) return 'lifetime';
  return null;
}

/**
 * Read the real free-trial phase off the product so the copy always matches the
 * configured Play offer (avoids "misrepresentation" rejections). A free trial is
 * an intro price of 0; its length comes from the product, never hardcoded.
 * Returns null when the product has no free trial.
 */
function freeTrial(pkg: PurchasesPackage | null): { length: string; phrase: string } | null {
  const intro = pkg?.product.introPrice;
  if (!intro || intro.price > 0 || !intro.periodNumberOfUnits) return null;
  const n = intro.periodNumberOfUnits;
  const unit = (intro.periodUnit ?? 'DAY').toLowerCase();
  return { length: `${n}-${unit}`, phrase: n === 1 ? `1 ${unit}` : `${n} ${unit}s` };
}

export default function Paywall() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ reason?: string }>();
  const reasonCap = params.reason === 'cap';
  const personaName = voiceName(useAppStore((s) => s.settings.voice));

  const offerings = useSubscriptionStore((s) => s.offerings);
  const loading = useSubscriptionStore((s) => s.loading);
  const error = useSubscriptionStore((s) => s.error);
  const isPremium = useSubscriptionStore((s) => s.isPremium);
  const isTrialing = useSubscriptionStore((s) => s.isTrialing);
  const purchase = useSubscriptionStore((s) => s.purchase);
  const restore = useSubscriptionStore((s) => s.restore);
  const refresh = useSubscriptionStore((s) => s.refresh);

  const tiers = useMemo(() => {
    const map: Partial<Record<TierId, PurchasesPackage>> = {};
    for (const pkg of offerings?.availablePackages ?? []) {
      const tier = classify(pkg);
      if (tier && !map[tier]) map[tier] = pkg;
    }
    return map;
  }, [offerings]);

  const [userSelection, setSelected] = useState<TierId | null>(null);
  // Default to annual when available, else first present tier — derived rather
  // than effect-driven so we don't double-render once offerings arrive.
  const selected: TierId =
    userSelection && tiers[userSelection]
      ? userSelection
      : tiers.annual
        ? 'annual'
        : tiers.monthly
          ? 'monthly'
          : 'lifetime';

  // Bounce out the moment the user is entitled (purchase / restore / live update).
  useEffect(() => {
    if (isPremium || isTrialing) {
      router.replace('/conversation' as never);
    }
  }, [isPremium, isTrialing, router]);

  // Hard-gate: swallow Android back so users can't slip past.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const selectedPkg = tiers[selected] ?? null;
  const trial = freeTrial(selectedPkg);

  const onBuy = async () => {
    if (!selectedPkg) return;
    const ok = await purchase(selectedPkg);
    if (!ok) {
      const err = useSubscriptionStore.getState().error;
      if (err) Alert.alert('Purchase failed', err);
    }
  };

  const onRestore = async () => {
    const ok = await restore();
    if (!ok) {
      Alert.alert(
        'No purchases found',
        'We couldn’t find an active subscription on this Google account.',
      );
    }
  };

  const openLink = (url: string) => {
    void WebBrowser.openBrowserAsync(url);
  };

  if (!offerings && loading) {
    return (
      <View style={[styles.loadingScreen, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.md }]}>
        <Pressable
          onPress={onRestore}
          accessibilityRole="button"
          accessibilityLabel="Restore purchases"
          hitSlop={10}>
          <Text style={[styles.restoreLink, { color: colors.textSecondary }]}>
            Restore
          </Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + Spacing.xl }]}>
        <Text style={[styles.title, { color: colors.text }]}>
          {reasonCap ? 'Need more time? Upgrade to Annual.' : 'Speak French in 30 days.'}
        </Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          {reasonCap
            ? 'You’ve hit your daily limit. Annual gives you 3× more practice for less than half the monthly rate.'
            : `Real conversation with ${personaName}. No flashcards. 10 minutes a day.`}
        </Text>

        <View style={styles.tiers}>
          {tiers.annual ? (
            <TierCard
              tier="annual"
              pkg={tiers.annual}
              label="Annual"
              caption="Best value · save 50%"
              badge="MOST POPULAR"
              selected={selected === 'annual'}
              onPress={() => setSelected('annual')}
            />
          ) : null}
          {tiers.monthly ? (
            <TierCard
              tier="monthly"
              pkg={tiers.monthly}
              label="Monthly"
              caption="Start with a free trial"
              selected={selected === 'monthly'}
              onPress={() => setSelected('monthly')}
            />
          ) : null}
          {tiers.lifetime ? (
            <TierCard
              tier="lifetime"
              pkg={tiers.lifetime}
              label="Lifetime"
              caption="One payment. Yours forever. 30-day money-back guarantee."
              selected={selected === 'lifetime'}
              onPress={() => setSelected('lifetime')}
            />
          ) : null}
        </View>

        {error && !loading ? (
          <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>
        ) : null}

        <Pressable
          onPress={onBuy}
          disabled={!selectedPkg || loading}
          accessibilityRole="button"
          accessibilityState={{ disabled: !selectedPkg || loading }}
          style={[
            styles.cta,
            {
              backgroundColor: colors.accent,
              opacity: !selectedPkg || loading ? 0.6 : 1,
            },
          ]}>
          {loading ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={[styles.ctaText, { color: colors.onAccent }]}>
              {trial
                ? `Start ${trial.length} free trial`
                : selected === 'lifetime'
                  ? 'Buy lifetime — one payment'
                  : `Buy ${selected} — ${selectedPkg?.product.priceString ?? ''}`}
            </Text>
          )}
        </Pressable>

        <Text style={[styles.fine, { color: colors.textFaint }]}>
          {trial
            ? `${trial.phrase} free, then ${selectedPkg?.product.priceString ?? ''}${
                selected === 'annual' ? ' billed yearly' : ' billed monthly'
              }. Cancel anytime in Google Play.`
            : 'One-time payment. No subscription, no renewal. 30-day money-back guarantee.'}
        </Text>

        <Pressable onPress={() => refresh()} hitSlop={10} style={styles.refresh}>
          <Ionicons name="refresh" size={14} color={colors.textFaint} />
          <Text style={[styles.refreshText, { color: colors.textFaint }]}>Refresh prices</Text>
        </Pressable>

        <View style={styles.legalRow}>
          <Pressable onPress={() => openLink(TERMS_URL)} hitSlop={6}>
            <Text style={[styles.legalLink, { color: colors.textSecondary }]}>Terms</Text>
          </Pressable>
          <Text style={[styles.legalDot, { color: colors.textFaint }]}>·</Text>
          <Pressable onPress={() => openLink(PRIVACY_URL)} hitSlop={6}>
            <Text style={[styles.legalLink, { color: colors.textSecondary }]}>Privacy</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

function TierCard({
  pkg,
  label,
  caption,
  badge,
  selected,
  onPress,
}: {
  tier: TierId;
  pkg: PurchasesPackage;
  label: string;
  caption: string;
  badge?: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[
        styles.tierCard,
        {
          borderColor: selected ? colors.accent : colors.border,
          backgroundColor: selected ? colors.accentSoft : colors.surface,
          borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
        },
      ]}>
      <View style={styles.tierTop}>
        <View style={styles.tierLabelCol}>
          <Text style={[styles.tierLabel, { color: colors.text }]}>{label}</Text>
          <Text style={[styles.tierCaption, { color: colors.textSecondary }]}>{caption}</Text>
        </View>
        <Text style={[styles.tierPrice, { color: colors.text }]}>
          {pkg.product.priceString}
        </Text>
      </View>
      {badge ? (
        <View style={[styles.badge, { backgroundColor: colors.accent }]}>
          <Text style={[styles.badgeText, { color: colors.onAccent }]}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  restoreLink: { fontSize: FontSize.caption, fontWeight: '600' },
  body: { paddingHorizontal: Spacing.lg, gap: Spacing.md },
  title: {
    fontSize: FontSize.display,
    fontWeight: '700',
    lineHeight: FontSize.display * 1.15,
    marginTop: Spacing.sm,
  },
  subtitle: {
    fontSize: FontSize.body,
    lineHeight: FontSize.body * 1.45,
    marginBottom: Spacing.md,
  },
  tiers: { gap: Spacing.sm },
  tierCard: {
    padding: Spacing.md,
    borderRadius: Radius.lg,
    gap: Spacing.xs,
  },
  tierTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tierLabelCol: { flex: 1, gap: 2 },
  tierLabel: { fontSize: FontSize.bubble, fontWeight: '700' },
  tierCaption: { fontSize: FontSize.caption },
  tierPrice: { fontSize: FontSize.bubble, fontWeight: '700' },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.sm,
    marginTop: Spacing.xs,
  },
  badgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  cta: {
    marginTop: Spacing.md,
    paddingVertical: Spacing.md + 2,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: { fontSize: FontSize.body, fontWeight: '700' },
  fine: {
    fontSize: FontSize.caption,
    textAlign: 'center',
    lineHeight: FontSize.caption * 1.4,
  },
  errorText: { fontSize: FontSize.caption, textAlign: 'center' },
  refresh: {
    flexDirection: 'row',
    alignSelf: 'center',
    alignItems: 'center',
    gap: 4,
    paddingVertical: Spacing.sm,
  },
  refreshText: { fontSize: FontSize.caption },
  legalRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  legalLink: { fontSize: FontSize.caption, fontWeight: '500' },
  legalDot: { fontSize: FontSize.caption },
});
