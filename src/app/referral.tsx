/**
 * Referral screen (modal) — the user's share code, funnel stats, and (while
 * still eligible) a redeem field. Copy sells the gift and the outcome, never
 * "minutes" as a mechanic (growth strategy: people share gifts, not coupons).
 *
 * The share link carries the code in the Play Install Referrer param so an
 * Android friend's onboarding pre-fills it; iOS friends type the code from the
 * message text.
 */
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { voiceName } from '@/lib/constants';
import {
  fetchReferralInfo,
  redeemReferralCode,
  type RedeemErrorCode,
  type ReferralInfo,
} from '@/lib/services/supabaseService';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';

const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.denny32.parlez';

const REDEEM_ERROR_COPY: Record<RedeemErrorCode, string> = {
  invalid_code: 'That code doesn’t look right — double-check it.',
  own_code: 'That’s your own code — share it with a friend instead!',
  already_redeemed: 'A code has already been used on this account.',
  not_eligible: 'Codes are for new learners — you already have full access.',
  code_exhausted: 'This code has reached its limit.',
  network: 'Couldn’t check the code right now. Try again in a moment.',
};

export default function Referral() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const personaName = voiceName(useAppStore((s) => s.settings.voice));

  const [info, setInfo] = useState<ReferralInfo | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [code, setCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemedNow, setRedeemedNow] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);

  useEffect(() => {
    void fetchReferralInfo().then((res) => {
      if (res) setInfo(res);
      else setLoadFailed(true);
    });
  }, []);

  const share = async () => {
    if (!info) return;
    const link = `${PLAY_URL}&referrer=${encodeURIComponent(`referral_code=${info.code}`)}`;
    try {
      await Share.share({
        message:
          `Have your first French conversation — my invite code ${info.code} ` +
          `gives you double the free time with ${personaName} on Parlez. ${link}`,
      });
    } catch {
      // User dismissed the sheet, or the platform has none — nothing to do.
    }
  };

  const redeem = async () => {
    if (!code.trim() || redeeming) return;
    setRedeeming(true);
    setRedeemError(null);
    const result = await redeemReferralCode(code);
    setRedeeming(false);
    if (result.ok) {
      setRedeemedNow(true);
    } else {
      setRedeemError(REDEEM_ERROR_COPY[result.error]);
    }
  };

  const bonusMinutes = info ? Math.round(info.grantedSeconds / 60) : 0;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <Text style={[styles.title, { color: colors.text }]}>Refer a friend</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close referral"
          hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.textSecondary} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + Spacing.xxl }]}>
        <Text style={[styles.lead, { color: colors.textSecondary }]}>
          Give a friend their first French conversation. They get double the free
          time with {personaName} — and you earn extra conversation time when they
          start speaking.
        </Text>

        {info === null && !loadFailed ? (
          <ActivityIndicator style={styles.spinner} color={colors.accent} />
        ) : null}

        {loadFailed ? (
          <Text style={[styles.lead, { color: colors.textSecondary }]}>
            Couldn’t load your invite code — check your connection and reopen this
            screen.
          </Text>
        ) : null}

        {info ? (
          <>
            <View
              style={[
                styles.codeCard,
                { backgroundColor: colors.surfaceMuted, borderColor: colors.border },
              ]}>
              <Text style={[styles.codeLabel, { color: colors.textSecondary }]}>
                Your invite code
              </Text>
              <Text
                selectable
                accessibilityLabel={`Invite code ${info.code}`}
                style={[styles.code, { color: colors.text }]}>
                {info.code}
              </Text>
            </View>

            <Pressable
              onPress={share}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.primary,
                { backgroundColor: colors.accent, opacity: pressed ? 0.7 : 1 },
              ]}>
              <Text style={[styles.primaryText, { color: colors.onAccent }]}>
                Share the gift
              </Text>
            </Pressable>

            <View style={styles.statsRow}>
              <View style={styles.stat}>
                <Text style={[styles.statValue, { color: colors.text }]}>
                  {info.stats.joined}
                </Text>
                <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
                  joined
                </Text>
              </View>
              <View style={styles.stat}>
                <Text style={[styles.statValue, { color: colors.text }]}>
                  {info.stats.activated}
                </Text>
                <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
                  speaking
                </Text>
              </View>
              <View style={styles.stat}>
                <Text style={[styles.statValue, { color: colors.text }]}>
                  {bonusMinutes > 0 ? `${bonusMinutes} min` : '—'}
                </Text>
                <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
                  time earned
                </Text>
              </View>
            </View>

            {info.mayRedeem && !redeemedNow ? (
              <View style={[styles.redeemBlock, { borderTopColor: colors.border }]}>
                <Text style={[styles.redeemTitle, { color: colors.text }]}>
                  Got a code from someone?
                </Text>
                <TextInput
                  value={code}
                  onChangeText={(t) => {
                    setCode(t.toUpperCase());
                    setRedeemError(null);
                  }}
                  placeholder="INVITE CODE"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={24}
                  accessibilityLabel="Invite code"
                  style={[
                    styles.codeInput,
                    {
                      backgroundColor: colors.surfaceMuted,
                      borderColor: redeemError ? colors.error : colors.border,
                      color: colors.text,
                    },
                  ]}
                />
                {redeemError ? (
                  <Text style={[styles.redeemError, { color: colors.error }]}>
                    {redeemError}
                  </Text>
                ) : null}
                <Pressable
                  onPress={redeem}
                  disabled={!code.trim() || redeeming}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.secondaryBtn,
                    {
                      borderColor: colors.accent,
                      opacity: !code.trim() || redeeming ? 0.4 : pressed ? 0.7 : 1,
                    },
                  ]}>
                  <Text style={[styles.secondaryBtnText, { color: colors.accent }]}>
                    {redeeming ? 'Checking…' : 'Redeem'}
                  </Text>
                </Pressable>
              </View>
            ) : null}

            {redeemedNow ? (
              <Text style={[styles.redeemedText, { color: colors.success }]}>
                Gift unlocked — double the free time with {personaName} 🎁
              </Text>
            ) : null}
          </>
        ) : null}
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
  body: { paddingHorizontal: Spacing.lg, gap: Spacing.lg },
  lead: { fontSize: FontSize.body, lineHeight: FontSize.body * 1.45 },
  spinner: { marginTop: Spacing.xl },
  codeCard: {
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.xl,
    gap: Spacing.xs,
  },
  codeLabel: { fontSize: FontSize.caption, fontWeight: '600' },
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
    paddingVertical: Spacing.md,
  },
  stat: { alignItems: 'center', gap: 2 },
  statValue: { fontSize: FontSize.title, fontWeight: '700' },
  statLabel: { fontSize: FontSize.caption },
  redeemBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Spacing.lg,
    gap: Spacing.md,
  },
  redeemTitle: { fontSize: FontSize.body, fontWeight: '600' },
  codeInput: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    fontSize: FontSize.bubble,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 3,
  },
  redeemError: {
    fontSize: FontSize.caption,
    textAlign: 'center',
    lineHeight: FontSize.caption * 1.4,
  },
  secondaryBtn: {
    borderWidth: 1.5,
    borderRadius: Radius.pill,
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  secondaryBtnText: { fontSize: FontSize.body, fontWeight: '700' },
  redeemedText: {
    fontSize: FontSize.body,
    fontWeight: '600',
    textAlign: 'center',
    lineHeight: FontSize.body * 1.4,
  },
});
