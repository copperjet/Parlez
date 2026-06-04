import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { supabase, syncAvailable } from '@/lib/supabase';
import { pushState, syncOnSignIn } from '@/lib/sync';
import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';

/**
 * Optional account (spec §4.5, §11.2 P1). Signing in enables cross-device sync
 * of the learning profile. The app is fully usable without ever opening this.
 */
export default function Account() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!supabase) return;
    supabase.auth
      .getSession()
      .then(({ data }) => setSignedInEmail(data.session?.user?.email ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setSignedInEmail(session?.user?.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const submit = async () => {
    if (!supabase || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const fn =
        mode === 'in'
          ? supabase.auth.signInWithPassword({ email, password })
          : supabase.auth.signUp({ email, password });
      const { error } = await fn;
      if (error) {
        setNotice(error.message);
      } else if (mode === 'up') {
        setNotice('Account created. Check your email to confirm, then sign in.');
      } else {
        await syncOnSignIn();
        setNotice('Signed in — your progress now syncs across devices.');
      }
    } catch {
      setNotice('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (!supabase) return;
    setBusy(true);
    await supabase.auth.signOut();
    setBusy(false);
    setNotice('Signed out. Your conversations stay on this device.');
  };

  const backUp = async () => {
    setBusy(true);
    const ok = await pushState();
    setBusy(false);
    setNotice(ok ? 'Backed up.' : 'Could not back up right now.');
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <Text style={[styles.title, { color: colors.text }]}>Account</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.textSecondary} />
        </Pressable>
      </View>

      <View style={styles.body}>
        <Text style={[styles.lead, { color: colors.textSecondary }]}>
          An account is optional. It only syncs what Marie has learned about you,
          so you can continue on another device.
        </Text>

        {!syncAvailable ? (
          <Text style={[styles.lead, { color: colors.textSecondary }]}>
            Account sync is not configured for this build.
          </Text>
        ) : signedInEmail ? (
          <>
            <View style={[styles.card, { backgroundColor: colors.surfaceMuted }]}>
              <Text style={[styles.signedIn, { color: colors.text }]}>
                {signedInEmail}
              </Text>
            </View>
            <Pressable
              onPress={backUp}
              disabled={busy}
              accessibilityRole="button"
              style={[styles.primary, { backgroundColor: colors.accent }]}>
              <Text style={[styles.primaryText, { color: colors.onAccent }]}>
                Back up now
              </Text>
            </Pressable>
            <Pressable onPress={signOut} disabled={busy} accessibilityRole="button">
              <Text style={[styles.link, { color: colors.textSecondary }]}>
                Sign out
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="Email"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              keyboardType="email-address"
              style={[
                styles.input,
                { backgroundColor: colors.surfaceMuted, color: colors.text },
              ]}
            />
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="Password"
              placeholderTextColor={colors.textFaint}
              secureTextEntry
              style={[
                styles.input,
                { backgroundColor: colors.surfaceMuted, color: colors.text },
              ]}
            />
            <Pressable
              onPress={submit}
              disabled={busy}
              accessibilityRole="button"
              style={[styles.primary, { backgroundColor: colors.accent }]}>
              {busy ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={[styles.primaryText, { color: colors.onAccent }]}>
                  {mode === 'in' ? 'Sign in' : 'Create account'}
                </Text>
              )}
            </Pressable>
            <Pressable
              onPress={() => setMode(mode === 'in' ? 'up' : 'in')}
              accessibilityRole="button">
              <Text style={[styles.link, { color: colors.textSecondary }]}>
                {mode === 'in'
                  ? 'No account? Create one'
                  : 'Already have an account? Sign in'}
              </Text>
            </Pressable>
          </>
        )}

        {notice ? (
          <Text style={[styles.notice, { color: colors.textSecondary }]}>{notice}</Text>
        ) : null}
      </View>
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
  body: { paddingHorizontal: Spacing.lg, gap: Spacing.md },
  lead: { fontSize: FontSize.body, lineHeight: FontSize.body * 1.45 },
  card: { borderRadius: Radius.md, padding: Spacing.md },
  signedIn: { fontSize: FontSize.body, fontWeight: '600' },
  input: {
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    fontSize: FontSize.body,
  },
  primary: {
    borderRadius: Radius.pill,
    paddingVertical: Spacing.md + 2,
    alignItems: 'center',
  },
  primaryText: { fontSize: FontSize.body, fontWeight: '700' },
  link: { fontSize: FontSize.body, textAlign: 'center', paddingVertical: Spacing.sm },
  notice: { fontSize: FontSize.caption, textAlign: 'center', lineHeight: FontSize.caption * 1.4 },
});
