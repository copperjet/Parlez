/**
 * Paywall — the only thing standing between a fresh install and the
 * conversation. Three tiers (Monthly / Annual / Lifetime); Annual is
 * default-selected. Monthly + Annual carry the 7-day Play-native intro trial.
 *
 * Prices come from `offerings.availablePackages[i].product.priceString` —
 * never hardcoded, so localisation + regional pricing Just Work.
 */
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { Image as ExpoImage } from 'expo-image';
import type { PurchasesPackage } from 'react-native-purchases';

import { PRIVACY_POLICY_URL, TERMS_URL } from '@/lib/constants';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';
import { useSubscriptionStore } from '@/stores/subscriptionStore';

type TierId = 'monthly' | 'annual' | 'lifetime';

const PRIVACY_URL = PRIVACY_POLICY_URL;

/** Animated flame celebrating the streak the free session just earned. */
const BURNING_FLAME = require('../../assets/images/burning flame.gif');

/**
 * Outcome guarantee shown under the CTA (spec: speak-or-refund). Annual and
 * Lifetime only — a 30-day guarantee on a ~30-day monthly term is a free month.
 */
const GUARANTEE =
  '30-day money-back guarantee. Do 10 minutes a day. If you can’t hold a basic conversation, we refund everything, no questions.';

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
  const reasonFree = params.reason === 'free';
  // A churned ex-subscriber. NOT a fresh free-taste user — they get resubscribe
  // copy, never the celebratory "your first session / first flame" framing.
  const reasonResub = params.reason === 'resub';

  const offerings = useSubscriptionStore((s) => s.offerings);
  const loading = useSubscriptionStore((s) => s.loading);
  const error = useSubscriptionStore((s) => s.error);
  const isPremium = useSubscriptionStore((s) => s.isPremium);
  const isTrialing = useSubscriptionStore((s) => s.isTrialing);
  const purchase = useSubscriptionStore((s) => s.purchase);
  const restore = useSubscriptionStore((s) => s.restore);
  const refresh = useSubscriptionStore((s) => s.refresh);
  const streakCount = useAppStore((s) => s.streakCount);

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
  // POP back to the conversation beneath rather than replace: the paywall was
  // pushed on top of an existing conversation, which itself flips to unlocked and
  // mounts ONE turn engine when entitlement lands. A `replace` would stack a
  // SECOND conversation (and a second engine + TTS player) on top of it — the
  // "Camille speaks twice" bug. Falling back to replace covers the rare case of
  // no back stack.
  useEffect(() => {
    if (isPremium || isTrialing) {
      if (router.canGoBack()) router.back();
      else router.replace('/conversation' as never);
    }
  }, [isPremium, isTrialing, router]);

  // Soft reasons (free-taste exhausted, daily cap) are dismissible back to the
  // now read-only conversation — the server still gates actual chat, so there's
  // nothing to "slip past". A hard open (no reason) still swallows Android back.
  const dismissible = reasonFree || reasonCap || reasonResub;
  const onDismiss = useCallback(() => {
    // Reached via push (upgrade bar / celebratory) or replace (turn-engine 403).
    // Prefer popping back to the conversation beneath; fall back to a replace.
    if (router.canGoBack()) router.back();
    else router.replace('/conversation' as never);
  }, [router]);
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android') return;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (dismissible) {
          onDismiss();
          return true;
        }
        return true;
      });
      return () => sub.remove();
    }, [dismissible, onDismiss]),
  );

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
        {dismissible ? (
          <Pressable
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={12}>
            <Ionicons name="close" size={26} color={colors.textSecondary} />
          </Pressable>
        ) : (
          <View />
        )}
        <Pressable
          onPress={onRestore}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Restore purchases"
          accessibilityState={{ disabled: loading }}
          hitSlop={10}>
          <Text
            style={[
              styles.restoreLink,
              { color: colors.textSecondary, opacity: loading ? 0.5 : 1 },
            ]}>
            Restore
          </Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + Spacing.xl }]}>
        {reasonFree ? (
          <View style={styles.celebrate}>
            <View style={styles.flameWrap}>
              <ExpoImage
                source={BURNING_FLAME}
                style={styles.flame}
                contentFit="contain"
                autoplay
              />
            </View>
            <Text style={[styles.celebrateLabel, { color: colors.accent }]}>
              {streakCount <= 1
                ? '🔥 Day 1 · your first flame'
                : `🔥 Day ${streakCount} · keep it burning`}
            </Text>
          </View>
        ) : null}
        <Text style={[styles.title, { color: colors.text }]}>
          {reasonFree
            ? 'You just spoke French. Keep going.'
            : reasonResub
              ? 'Welcome back. Pick up where you left off.'
              : reasonCap
                ? 'Keep going. You will speak French.'
                : 'You will speak French. That’s the guarantee.'}
        </Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          {reasonFree
            ? 'That was your first session with Camille, and your first streak day. Keep your flame lit and your French growing, with the same guarantee: speak, or your money back.'
            : reasonResub
              ? 'Your subscription has ended. Resubscribe to keep speaking French, with the same guarantee: speak, or your money back.'
              : reasonCap
                ? 'You’ve hit today’s limit. Annual gives you 3× the daily practice, and the same guarantee: speak, or your money back.'
                : 'Every French app taught you words. Parlez makes you speak them. No flashcards, no grammar drills.'}
        </Text>

        <View style={styles.tiers}>
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
                  ? 'Speak French · one payment'
                  : `Speak French · ${selectedPkg?.product.priceString ?? ''}${
                      selected === 'annual' ? '/yr' : '/mo'
                    }`}
            </Text>
          )}
        </Pressable>

        <Text style={[styles.fine, { color: colors.textFaint }]}>
          {trial
            ? `${trial.phrase} free, then ${selectedPkg?.product.priceString ?? ''}${
                selected === 'annual' ? ' billed yearly' : ' billed monthly'
              }, cancel anytime.${selected === 'monthly' ? '' : ` ${GUARANTEE}`}`
            : selected === 'lifetime'
              ? `One payment. No subscription, no renewal. ${GUARANTEE}`
              : selected === 'monthly'
                ? 'Billed monthly, cancel anytime.'
                : GUARANTEE}
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
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  restoreLink: { fontSize: FontSize.caption, fontWeight: '600' },
  body: { paddingHorizontal: Spacing.lg, gap: Spacing.md },
  celebrate: { alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.xs },
  flameWrap: {
    width: 104,
    height: 104,
    borderRadius: Radius.pill,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  flame: { width: 84, height: 84 },
  celebrateLabel: { fontSize: FontSize.body, fontWeight: '700' },
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
