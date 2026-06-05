/**
 * Account screen — Sign in to enable cross-device sync.
 *
 * iOS: Sign in with Apple (required by App Store guidelines when offering any
 *   third-party sign-in). Supabase receives the Apple identity token and creates
 *   or links the user. The RC anonymous user is aliased onto the Supabase UID
 *   so purchases transfer.
 *
 * Android: Email + password auth via Supabase. Same alias flow after sign-in.
 *
 * The app is fully functional without an account — this is purely opt-in sync.
 */
import { Ionicons } from '@expo/vector-icons';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FontSize, Radius, Spacing, useTheme } from '@/lib/theme';
import { onSignIn } from '@/lib/sync';
import { supabase, syncAvailable } from '@/lib/supabase';

interface AccountInfo {
  id: string;
  email: string | null;
  provider: string | null;
}

async function loadAccount(): Promise<AccountInfo | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  return {
    id: data.user.id,
    email: data.user.email ?? null,
    provider: data.user.app_metadata?.provider ?? null,
  };
}

function InfoRow({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.infoRow, { borderBottomColor: colors.border }]}>
      <Text style={[styles.infoLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: colors.text }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export default function Account() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Android email/password form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<'signIn' | 'signUp'>('signIn');
  const [notice, setNotice] = useState('');

  const reload = useCallback(async () => {
    const acct = await loadAccount();
    setAccount(acct);
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    loadAccount().then((acct) => {
      if (!active) return;
      setAccount(acct);
      setLoading(false);
    }).catch(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  // ── iOS: Sign in with Apple ─────────────────────────────────────────────────

  const signInWithApple = async () => {
    if (!supabase) return;
    setBusy(true);
    try {
      // Nonce binds the credential to this request (replay protection). Apple
      // signs the SHA-256 of the nonce into the identity token; Supabase verifies
      // it against the raw nonce we pass alongside.
      const rawNonce = Crypto.randomUUID();
      const hashedNonce = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        rawNonce,
      );
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: hashedNonce,
      });
      if (!credential.identityToken) throw new Error('No identity token from Apple');
      const { data, error } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken,
        nonce: rawNonce,
      });
      if (error) throw error;
      if (data.user) {
        await onSignIn(data.user.id);
        await reload();
      }
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ERR_REQUEST_CANCELED') return; // user dismissed sheet
      Alert.alert(
        'Sign-in failed',
        err instanceof Error ? err.message : 'Something went wrong.',
      );
    } finally {
      setBusy(false);
    }
  };

  // ── Android: email + password ───────────────────────────────────────────────

  const submitEmailAuth = async () => {
    if (!supabase || busy) return;
    setBusy(true);
    setNotice('');
    try {
      if (authMode === 'signUp') {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) { setNotice(error.message); return; }
        setNotice('Account created. Check your email to confirm, then sign in.');
        setAuthMode('signIn');
        return;
      }
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { setNotice(error.message); return; }
      if (data.user) {
        await onSignIn(data.user.id);
        await reload();
      }
    } catch {
      setNotice('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  // ── Shared: sign out + delete ───────────────────────────────────────────────

  const signOut = () => {
    Alert.alert(
      'Sign out?',
      'Your learning progress stays on this device. Sign back in anytime to re-sync.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: async () => {
            if (!supabase) return;
            setBusy(true);
            try {
              await supabase.auth.signOut();
              setAccount(null);
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  const confirmDeleteAccount = () => {
    Alert.alert(
      'Delete account?',
      'This permanently removes your account and subscription data. Your local progress stays on this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete account',
          style: 'destructive',
          onPress: async () => {
            if (!supabase) return;
            setBusy(true);
            try {
              const { error } = await (supabase as any).functions.invoke('delete-account');
              if (error) throw error;
              await supabase.auth.signOut();
              setAccount(null);
              Alert.alert('Account deleted', 'Your account has been removed.');
            } catch (err: unknown) {
              Alert.alert(
                'Could not delete account',
                err instanceof Error ? err.message : 'Please try again later.',
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: insets.top + Spacing.sm }]}>
        <Text style={[styles.title, { color: colors.text }]}>Account</Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Close account"
          hitSlop={12}>
          <Ionicons name="close" size={26} color={colors.textSecondary} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + Spacing.xl }]}
        keyboardShouldPersistTaps="handled">

        {loading ? (
          <ActivityIndicator color={colors.accent} style={styles.spinner} />
        ) : !syncAvailable ? (
          <Text style={[styles.lead, { color: colors.textSecondary }]}>
            Account sync is not configured for this build.
          </Text>
        ) : account ? (
          // ── Signed in ──────────────────────────────────────────────────────
          <>
            <View style={[styles.card, { backgroundColor: colors.surface }]}>
              <InfoRow label="Email" value={account.email ?? 'Hidden by Apple'} />
              {account.provider ? (
                <InfoRow label="Provider" value={account.provider} />
              ) : null}
              <InfoRow label="Sync" value="On — progress synced across devices" />
            </View>

            <Pressable
              onPress={signOut}
              disabled={busy}
              accessibilityRole="button"
              style={[
                styles.secondaryBtn,
                { borderColor: colors.border, opacity: busy ? 0.6 : 1 },
              ]}>
              <Text style={[styles.secondaryBtnText, { color: colors.text }]}>Sign out</Text>
            </Pressable>

            <Pressable
              onPress={confirmDeleteAccount}
              disabled={busy}
              accessibilityRole="button"
              style={styles.deleteRow}>
              <Text style={[styles.deleteText, { color: colors.error }]}>Delete account…</Text>
            </Pressable>
          </>
        ) : (
          // ── Signed out ─────────────────────────────────────────────────────
          <>
            <View style={[styles.explainer, { backgroundColor: colors.surface }]}>
              <Ionicons name="sync" size={32} color={colors.accent} />
              <Text style={[styles.explainerTitle, { color: colors.text }]}>
                Sync your progress
              </Text>
              <Text style={[styles.explainerBody, { color: colors.textSecondary }]}>
                Sign in to back up your level, vocabulary patterns, and streak — and pick up where you left off after a reinstall or on a new device.
              </Text>
            </View>

            {Platform.OS === 'ios' ? (
              // Apple Sign-In button
              busy ? (
                <ActivityIndicator color={colors.accent} style={styles.spinner} />
              ) : (
                <AppleAuthentication.AppleAuthenticationButton
                  buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                  buttonStyle={
                    colors.background === '#15130F'
                      ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                      : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
                  }
                  cornerRadius={Radius.pill}
                  style={styles.appleBtn}
                  onPress={signInWithApple}
                />
              )
            ) : (
              // Android: email + password
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
                    { backgroundColor: colors.surface, color: colors.text },
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
                    { backgroundColor: colors.surface, color: colors.text },
                  ]}
                />
                <Pressable
                  onPress={submitEmailAuth}
                  disabled={busy}
                  accessibilityRole="button"
                  style={[
                    styles.primaryBtn,
                    { backgroundColor: colors.accent, opacity: busy ? 0.6 : 1 },
                  ]}>
                  {busy ? (
                    <ActivityIndicator color={colors.onAccent} />
                  ) : (
                    <Text style={[styles.primaryBtnText, { color: colors.onAccent }]}>
                      {authMode === 'signIn' ? 'Sign in' : 'Create account'}
                    </Text>
                  )}
                </Pressable>
                <Pressable
                  onPress={() => {
                    setAuthMode(authMode === 'signIn' ? 'signUp' : 'signIn');
                    setNotice('');
                  }}
                  accessibilityRole="button">
                  <Text style={[styles.toggleText, { color: colors.textSecondary }]}>
                    {authMode === 'signIn'
                      ? 'No account? Create one'
                      : 'Already have an account? Sign in'}
                  </Text>
                </Pressable>
                {notice ? (
                  <Text style={[styles.notice, { color: colors.textSecondary }]}>{notice}</Text>
                ) : null}
              </>
            )}
          </>
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
  body: { paddingHorizontal: Spacing.lg, gap: Spacing.md, paddingTop: Spacing.md },
  lead: { fontSize: FontSize.body, lineHeight: FontSize.body * 1.45 },
  spinner: { marginTop: Spacing.xxl },
  card: { borderRadius: Radius.lg, overflow: 'hidden' },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.md,
  },
  infoLabel: { fontSize: FontSize.caption, fontWeight: '500', flexShrink: 0 },
  infoValue: { fontSize: FontSize.caption, flexShrink: 1, textAlign: 'right' },
  secondaryBtn: {
    paddingVertical: Spacing.md,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    marginTop: Spacing.sm,
  },
  secondaryBtnText: { fontSize: FontSize.body, fontWeight: '600' },
  deleteRow: { alignItems: 'center', paddingVertical: Spacing.lg },
  deleteText: { fontSize: FontSize.caption, fontWeight: '500' },
  explainer: {
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  explainerTitle: { fontSize: FontSize.bubble, fontWeight: '700', textAlign: 'center' },
  explainerBody: {
    fontSize: FontSize.body,
    lineHeight: FontSize.body * 1.45,
    textAlign: 'center',
  },
  appleBtn: { width: '100%', height: 52, marginTop: Spacing.sm },
  input: {
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    fontSize: FontSize.body,
  },
  primaryBtn: {
    borderRadius: Radius.pill,
    paddingVertical: Spacing.md + 2,
    alignItems: 'center',
  },
  primaryBtnText: { fontSize: FontSize.body, fontWeight: '700' },
  toggleText: {
    fontSize: FontSize.body,
    textAlign: 'center',
    paddingVertical: Spacing.sm,
  },
  notice: {
    fontSize: FontSize.caption,
    textAlign: 'center',
    lineHeight: FontSize.caption * 1.4,
  },
});
