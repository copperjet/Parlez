import { Ionicons } from '@expo/vector-icons';
import * as Application from 'expo-application';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SPLASH_MS, voiceName } from '@/lib/constants';
import { requestRecognitionPermissions } from '@/lib/audio/recognizer';
import { saveOnboarding } from '@/lib/db/sessions';
import { redeemReferralCode, type RedeemErrorCode } from '@/lib/services/supabaseService';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import type { OnboardingChoice } from '@/lib/types';
import { useAppStore } from '@/stores/appStore';

type Step = 'splash' | 'level' | 'referral' | 'permission';

const REDEEM_ERROR_COPY: Record<RedeemErrorCode, string> = {
  invalid_code: 'That code doesn’t look right — double-check it.',
  own_code: 'That’s your own code — share it with a friend instead!',
  already_redeemed: 'A code has already been used here.',
  not_eligible: 'Codes are for new learners — you already have full access.',
  code_exhausted: 'This code has reached its limit.',
  network: 'Couldn’t check the code right now — you can skip and try later.',
};

const LEVEL_OPTIONS: { choice: OnboardingChoice; title: string; subtitle: string }[] = [
  { choice: 'nothing', title: 'Starting fresh', subtitle: 'I don’t know any French yet' },
  { choice: 'little', title: 'A little', subtitle: 'I know some words and phrases' },
  { choice: 'some', title: 'Some', subtitle: 'I studied before but can’t really speak it' },
  { choice: 'decent', title: 'Decent', subtitle: 'I can have basic conversations' },
];

/**
 * Onboarding (spec §3.1): splash -> one level question -> microphone primer.
 * Designed to land the user in conversation within 60 seconds. No account,
 * no labels like "beginner", nothing the user does not strictly need.
 */
export default function Onboarding() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const personaName = voiceName(useAppStore((s) => s.settings.voice));

  const [step, setStep] = useState<Step>('splash');
  const [denied, setDenied] = useState(false);
  const [code, setCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemed, setRedeemed] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setStep('level'), SPLASH_MS);
    return () => clearTimeout(t);
  }, []);

  // Android installs carry the Play Install Referrer — a share link with
  // ?referrer=referral_code%3DXXXX pre-fills the invite code so the referred
  // friend doesn't have to type it. iOS has no equivalent; manual entry there.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void Application.getInstallReferrerAsync()
      .then((referrer) => {
        const m = /(?:^|[?&])referral_code=([A-Za-z0-9-]+)/.exec(referrer ?? '');
        if (m) setCode(m[1].toUpperCase());
      })
      .catch(() => {
        // best-effort — the field just starts empty
      });
  }, []);

  const pickLevel = (choice: OnboardingChoice) => {
    completeOnboarding(choice);
    void saveOnboarding(choice, useAppStore.getState().level);
    setStep('referral');
  };

  const redeem = async () => {
    if (!code.trim() || redeeming) return;
    setRedeeming(true);
    setRedeemError(null);
    const result = await redeemReferralCode(code);
    setRedeeming(false);
    if (result.ok) {
      setRedeemed(true);
      // Let the gift moment land, then move on.
      setTimeout(() => setStep('permission'), 1400);
    } else {
      setRedeemError(REDEEM_ERROR_COPY[result.error]);
    }
  };

  const askMic = async () => {
    if (Platform.OS === 'web') {
      router.replace('/conversation');
      return;
    }
    try {
      const { granted } = await requestRecognitionPermissions();
      if (granted) {
        router.replace('/conversation');
      } else {
        setDenied(true);
      }
    } catch {
      router.replace('/conversation');
    }
  };

  return (
    <View
      style={[
        styles.screen,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top + Spacing.xl,
          paddingBottom: insets.bottom + Spacing.xl,
        },
      ]}>
      {step === 'splash' ? (
        <Animated.View entering={FadeIn.duration(500)} exiting={FadeOut} style={styles.center}>
          <Text style={[styles.brand, { color: colors.text }]}>Parlez</Text>
          <Text style={[styles.tag, { color: colors.textSecondary }]}>
            Speak French. From day one.
          </Text>
        </Animated.View>
      ) : null}

      {step === 'level' ? (
        <Animated.View entering={FadeIn.duration(400)} style={styles.flex}>
          <ScrollView
            contentContainerStyle={styles.levelScroll}
            showsVerticalScrollIndicator={false}>
            <Text style={[styles.title, { color: colors.text }]}>
              How much French do you know?
            </Text>
            {LEVEL_OPTIONS.map((opt) => (
              <Pressable
                key={opt.choice}
                onPress={() => pickLevel(opt.choice)}
                accessibilityRole="button"
                accessibilityLabel={`${opt.title}. ${opt.subtitle}`}
                style={({ pressed }) => [
                  styles.option,
                  {
                    backgroundColor: colors.surfaceMuted,
                    borderColor: colors.border,
                    opacity: pressed ? 0.6 : 1,
                  },
                ]}>
                <View style={styles.optionTextCol}>
                  <Text style={[styles.optionTitle, { color: colors.text }]}>{opt.title}</Text>
                  <Text style={[styles.optionSubtitle, { color: colors.textSecondary }]}>
                    {opt.subtitle}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textFaint} />
              </Pressable>
            ))}
          </ScrollView>
        </Animated.View>
      ) : null}

      {step === 'referral' ? (
        <Animated.View entering={FadeIn.duration(400)} style={styles.flex}>
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.flex}>
            <View style={styles.center}>
              <Text style={[styles.title, { color: colors.text }]}>
                Did a friend send you?
              </Text>
              <Text style={[styles.tag, { color: colors.textSecondary }]}>
                Enter their code and you both get more time with {personaName}.
              </Text>
              {redeemed ? (
                <Text style={[styles.redeemedText, { color: colors.success }]}>
                  Gift unlocked — double the free time with {personaName} 🎁
                </Text>
              ) : (
                <>
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
                </>
              )}
            </View>

            {!redeemed ? (
              <View style={styles.actions}>
                <Pressable
                  onPress={redeem}
                  disabled={!code.trim() || redeeming}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.primary,
                    {
                      backgroundColor: colors.accent,
                      opacity: !code.trim() || redeeming ? 0.4 : pressed ? 0.7 : 1,
                    },
                  ]}>
                  <Text style={[styles.primaryText, { color: colors.onAccent }]}>
                    {redeeming ? 'Checking…' : 'Redeem'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setStep('permission')}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.secondary, { opacity: pressed ? 0.6 : 1 }]}>
                  <Text style={[styles.secondaryText, { color: colors.textSecondary }]}>
                    No code — keep going
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </KeyboardAvoidingView>
        </Animated.View>
      ) : null}

      {step === 'permission' ? (
        <Animated.View entering={FadeIn.duration(400)} style={styles.flex}>
          <View style={styles.center}>
            <Text style={[styles.title, { color: colors.text }]}>
              Parlez listens to your voice so {personaName} can speak with you.
            </Text>
            {denied ? (
              <Text style={[styles.denied, { color: colors.textSecondary }]}>
                Microphone access is off. {personaName} needs it to hear you. You can
                enable it in Settings.
              </Text>
            ) : null}
          </View>

          <View style={styles.actions}>
            {denied ? (
              <>
                <Pressable
                  onPress={() => Linking.openSettings()}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    styles.primary,
                    { backgroundColor: colors.accent, opacity: pressed ? 0.7 : 1 },
                  ]}>
                  <Text style={[styles.primaryText, { color: colors.onAccent }]}>
                    Open Settings
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => router.replace('/conversation')}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.secondary, { opacity: pressed ? 0.6 : 1 }]}>
                  <Text style={[styles.secondaryText, { color: colors.textSecondary }]}>
                    Continue anyway
                  </Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                onPress={askMic}
                accessibilityRole="button"
                style={({ pressed }) => [
                  styles.primary,
                  { backgroundColor: colors.accent, opacity: pressed ? 0.7 : 1 },
                ]}>
                <Text style={[styles.primaryText, { color: colors.onAccent }]}>
                  Start speaking
                </Text>
              </Pressable>
            )}
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: Spacing.xl },
  flex: { flex: 1, justifyContent: 'space-between' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm },
  brand: { fontSize: 44, fontWeight: '700', letterSpacing: 1 },
  tag: { fontSize: FontSize.body },
  title: {
    fontSize: FontSize.title,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: Spacing.sm,
    lineHeight: FontSize.title * 1.35,
  },
  levelScroll: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.xl,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
  },
  optionTextCol: { flex: 1, gap: 3 },
  optionTitle: { fontSize: FontSize.bubble, fontWeight: '700' },
  optionSubtitle: { fontSize: FontSize.caption, lineHeight: FontSize.caption * 1.4 },
  denied: {
    fontSize: FontSize.body,
    textAlign: 'center',
    marginTop: Spacing.md,
    lineHeight: FontSize.body * 1.4,
  },
  codeInput: {
    alignSelf: 'stretch',
    marginTop: Spacing.lg,
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md + 2,
    fontSize: FontSize.title,
    fontWeight: '700',
    textAlign: 'center',
    letterSpacing: 3,
  },
  redeemError: {
    fontSize: FontSize.caption,
    textAlign: 'center',
    lineHeight: FontSize.caption * 1.4,
  },
  redeemedText: {
    fontSize: FontSize.body,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: Spacing.lg,
    lineHeight: FontSize.body * 1.4,
  },
  actions: { gap: Spacing.sm },
  primary: {
    borderRadius: Radius.pill,
    paddingVertical: Spacing.md + 2,
    alignItems: 'center',
  },
  primaryText: { fontSize: FontSize.body, fontWeight: '700' },
  secondary: { paddingVertical: Spacing.md, alignItems: 'center' },
  secondaryText: { fontSize: FontSize.body },
});
