/**
 * Sign-in nudge (anonymous users only).
 *
 * Parlez is fully usable without an account, but an anonymous user's learning
 * profile + streak live only in local storage and are lost on reinstall / a new
 * device. Rather than wall the app behind sign-in (which would kill the
 * speak-in-60-seconds activation), we surface a soft, value-anchored prompt once
 * the user has *earned* something worth protecting — a streak milestone.
 *
 * Shows when: sync is configured, the user is signed out, and the streak has
 * reached a milestone past the last one they dismissed. Dismissing (tap-through
 * to sign-in, or the ✕) records the milestone so it never nags at the same one
 * twice; the next milestone re-surfaces it. See dueSignInMilestone in lib/streak.
 */
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { dueSignInMilestone } from '@/lib/streak';
import { loadSignInNudgeDismissed, saveSignInNudgeDismissed } from '@/lib/db/sessions';
import { supabase, syncAvailable } from '@/lib/supabase';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { useAppStore } from '@/stores/appStore';

export function SignInNudge() {
  const { colors } = useTheme();
  const router = useRouter();
  const streakCount = useAppStore((s) => s.streakCount);

  // Tracks live auth state so the nudge disappears the instant the user signs in.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    if (!syncAvailable || !supabase) {
      setSignedIn(true); // treat "no sync configured" as "nothing to offer"
      setDismissedAt(0);
      return;
    }
    void loadSignInNudgeDismissed().then((n) => active && setDismissedAt(n));
    void supabase.auth.getUser().then(({ data }) => active && setSignedIn(!!data.user));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (active) setSignedIn(!!session?.user);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Still resolving state, or nothing to show.
  if (signedIn !== false || dismissedAt == null) return null;
  const milestone = dueSignInMilestone(streakCount, dismissedAt);
  if (milestone == null) return null;

  const remember = () => {
    setDismissedAt(milestone);
    void saveSignInNudgeDismissed(milestone);
  };
  const openSignIn = () => {
    remember(); // if they return without signing in, don't nag at this milestone again
    router.push('/account');
  };

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.accentSoft, borderBottomColor: colors.accent },
      ]}>
      <Pressable
        onPress={openSignIn}
        accessibilityRole="button"
        accessibilityLabel={`Sign in to back up your ${milestone}-day streak`}
        style={styles.body}>
        <Ionicons name="cloud-upload-outline" size={20} color={colors.accent} />
        <Text style={[styles.text, { color: colors.accent }]} numberOfLines={2}>
          {`Back up your ${milestone}-day streak. Sign in so you never lose your progress.`}
        </Text>
      </Pressable>
      <Pressable
        onPress={remember}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        hitSlop={10}
        style={styles.close}>
        <Ionicons name="close" size={18} color={colors.accent} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  text: {
    flex: 1,
    fontSize: FontSize.caption,
    fontWeight: '600',
    lineHeight: FontSize.caption * 1.35,
  },
  close: { padding: Spacing.xs, borderRadius: Radius.pill },
})
