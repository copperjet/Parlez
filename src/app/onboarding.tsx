import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SPLASH_MS } from '@/lib/constants';
import { requestRecognitionPermissions } from '@/lib/audio/recognizer';
import { saveOnboarding } from '@/lib/db/sessions';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import type { OnboardingChoice } from '@/lib/types';
import { useAppStore } from '@/stores/appStore';

type Step = 'splash' | 'level' | 'permission';

const LEVEL_OPTIONS: { choice: OnboardingChoice; label: string }[] = [
  { choice: 'nothing', label: 'Nothing yet — I’m starting fresh' },
  { choice: 'little', label: 'A little — I know some words and phrases' },
  { choice: 'some', label: 'Some — I studied French before but can’t really speak it' },
  { choice: 'decent', label: 'Decent — I can have basic conversations' },
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

  const [step, setStep] = useState<Step>('splash');
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setStep('level'), SPLASH_MS);
    return () => clearTimeout(t);
  }, []);

  const pickLevel = (choice: OnboardingChoice) => {
    completeOnboarding(choice);
    void saveOnboarding(choice, useAppStore.getState().level);
    setStep('permission');
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
                accessibilityLabel={opt.label}
                style={({ pressed }) => [
                  styles.option,
                  {
                    backgroundColor: colors.surfaceMuted,
                    borderColor: colors.border,
                    opacity: pressed ? 0.6 : 1,
                  },
                ]}>
                <Text style={[styles.optionText, { color: colors.text }]}>{opt.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </Animated.View>
      ) : null}

      {step === 'permission' ? (
        <Animated.View entering={FadeIn.duration(400)} style={styles.flex}>
          <View style={styles.center}>
            <Text style={[styles.title, { color: colors.text }]}>
              Parlez listens to your voice so Marie can speak with you.
            </Text>
            {denied ? (
              <Text style={[styles.denied, { color: colors.textSecondary }]}>
                Microphone access is off. Marie needs it to hear you — you can
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
    borderWidth: 1,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.lg,
  },
  optionText: { fontSize: FontSize.body, lineHeight: FontSize.body * 1.35 },
  denied: {
    fontSize: FontSize.body,
    textAlign: 'center',
    marginTop: Spacing.md,
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
