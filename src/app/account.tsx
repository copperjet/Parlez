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
import * as WebBrowser from 'expo-web-browser';
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
import {
  clearActivity,
  clearDailyActivity,
  clearMessages,
  clearStreak,
  clearStructuredProfile,
  saveProfileSummary,
} from '@/lib/db/sessions';
import { clearProfile } from '@/lib/db/profile';
import { useAppStore } from '@/stores/appStore';
import { planSummary, useSubscriptionStore } from '@/stores/subscriptionStore';

const PLAY_SUB_URL =
  'https://play.google.com/store/account/subscriptions?package=com.denny32.parlez';
const IOS_SUB_URL = 'https://apps.apple.com/account/subscriptions';
const SUB_URL = Platform.OS === 'ios' ? IOS_SUB_URL : PLAY_SUB_URL;

interface AccountInfo {
  id: string;
  email: string | null;
}

async function loadAccount(): Promise<AccountInfo | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  return {
    id: data.user.id,
    email: data.user.email ?? null,
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

  const isPremium = useSubscriptionStore((s) => s.isPremium);
  const isTrialing = useSubscriptionStore((s) => s.isTrialing);
  const tier = useSubscriptionStore((s) => s.tier);
  const streakCount = useAppStore((s) => s.streakCount);
  const [subBusy, setSubBusy] = useState(false);

  // Android email/password form state
  type AuthMode = 'signIn' | 'signUp' | 'resetRequest' | 'resetVerify' | 'confirmVerify';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMode, setAuthMode] = useState<AuthMode>('signIn');
  const [notice, setNotice] = useState('');
  // Password-recovery state (OTP emailed by Supabase, no external service).
  const [otpCode, setOtpCode] = useState('');
  const [newPassword, setNewPassword] = useState('');

  /** Switch auth modes, dropping any stale notice / recovery input. */
  const switchMode = (mode: AuthMode) => {
    setAuthMode(mode);
    setNotice('');
    setOtpCode('');
    setNewPassword('');
  };

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
        // Email confirmation is OTP-based (in-app), not a magic link — Supabase
        // emails a 6-digit code (the Confirm signup template must include
        // {{ .Token }}). Collect it next; verifyOtp signs the user straight in.
        setOtpCode('');
        setAuthMode('confirmVerify');
        setNotice('Confirmation code sent — check your email.');
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

  // ── Android: forgot password (OTP recovery) ─────────────────────────────────
  // Supabase's built-in mailer sends a 6-digit code (the Reset Password email
  // template must include {{ .Token }}); verifyOtp(type:'recovery') signs the
  // user in, then we set the new password on that session.

  const requestReset = async () => {
    if (!supabase || busy) return;
    const addr = email.trim();
    if (!addr) { setNotice('Enter your email first.'); return; }
    setBusy(true);
    setNotice('');
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(addr);
      if (error) { setNotice(error.message); return; }
      setAuthMode('resetVerify');
      setNotice('Code sent — check your email.');
    } catch {
      setNotice('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const submitReset = async () => {
    if (!supabase || busy) return;
    const addr = email.trim();
    const token = otpCode.trim();
    if (!token || !newPassword) { setNotice('Enter the code and a new password.'); return; }
    setBusy(true);
    setNotice('');
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: addr,
        token,
        type: 'recovery',
      });
      if (error) { setNotice(error.message); return; }
      const { error: updErr } = await supabase.auth.updateUser({ password: newPassword });
      if (updErr) { setNotice(updErr.message); return; }
      if (data.user) {
        await onSignIn(data.user.id);
        await reload();
      }
      switchMode('signIn');
      setNotice('Password updated.');
    } catch {
      setNotice('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  // ── Android: confirm email (OTP) ────────────────────────────────────────────
  // verifyOtp(type:'signup') both confirms the address and establishes a session,
  // so the user lands signed-in — no separate sign-in step.

  const submitConfirm = async () => {
    if (!supabase || busy) return;
    const addr = email.trim();
    const token = otpCode.trim();
    if (!token) { setNotice('Enter the code from the email.'); return; }
    setBusy(true);
    setNotice('');
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        email: addr,
        token,
        type: 'signup',
      });
      if (error) { setNotice(error.message); return; }
      if (data.user) {
        await onSignIn(data.user.id);
        await reload();
      }
      switchMode('signIn');
      setNotice('Email confirmed — you’re signed in.');
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
              const { error } = await supabase.auth.signOut();
              if (error) throw error;
              setAccount(null);
            } catch (err: unknown) {
              Alert.alert(
                'Could not sign out',
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

  const confirmDeleteAccount = () => {
    Alert.alert(
      'Delete account?',
      'This permanently removes your account, your subscription record, and everything on this device. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete account',
          style: 'destructive',
          onPress: async () => {
            if (!supabase) return;
            setBusy(true);
            try {
              // The function derives the user from the bearer JWT this call
              // attaches automatically — no body needed.
              const { error } = await (supabase as any).functions.invoke('delete-account');
              if (error) throw error;

              // True deletion: also wipe the local footprint and the cached
              // entitlement, then drop the session.
              useAppStore.getState().resetAll();
              void clearMessages();
              void clearProfile();
              void clearStructuredProfile();
              void clearStreak();
              void clearDailyActivity();
              void clearActivity();
              void saveProfileSummary('');
              await useSubscriptionStore.getState().logOutAndReset();
              await supabase.auth.signOut();
              setAccount(null);
              Alert.alert('Account deleted', 'Your account and data have been removed.');
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

  // ── Subscription (works signed-in or anonymous — entitlement is RevenueCat's,
  // keyed to the device's store account, independent of Supabase auth) ─────────

  const onManageSub = () => {
    void WebBrowser.openBrowserAsync(SUB_URL);
  };

  const onUpgrade = () => {
    router.push('/paywall' as never);
  };

  /** Re-check entitlement; if still not premium, sync the store receipt. */
  const onRefreshSub = async () => {
    if (subBusy) return;
    setSubBusy(true);
    try {
      const sub = useSubscriptionStore.getState();
      await sub.refresh();
      if (!useSubscriptionStore.getState().isPremium) {
        await sub.restore();
      }
      const now = useSubscriptionStore.getState();
      Alert.alert(
        now.isPremium ? 'Subscription active' : 'No subscription found',
        now.isPremium
          ? planSummary({ isPremium: now.isPremium, isTrialing: now.isTrialing, tier: now.tier })
          : `We couldn't find an active subscription on this ${Platform.OS === 'ios' ? 'Apple' : 'Google'} account.`,
      );
    } finally {
      setSubBusy(false);
    }
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
          // ── Signed in: account info (management actions live at the bottom) ──
          <View style={[styles.card, { backgroundColor: colors.surface }]}>
            <InfoRow label="Email" value={account.email ?? 'Hidden by Apple'} />
            <InfoRow
              label="Streak"
              value={streakCount > 0 ? `Day ${streakCount}` : 'Not started yet'}
            />
            <InfoRow label="Sync" value="On, progress synced across devices" />
          </View>
        ) : (
          // ── Signed out ─────────────────────────────────────────────────────
          <>
            <View style={[styles.explainer, { backgroundColor: colors.surface }]}>
              <Ionicons name="sync" size={32} color={colors.accent} />
              <Text style={[styles.explainerTitle, { color: colors.text }]}>
                Sync your progress
              </Text>
              <Text style={[styles.explainerBody, { color: colors.textSecondary }]}>
                Sign in to back up your progress and pick up on any device.
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
              // Android: email + password (with OTP password recovery)
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
                {authMode === 'signIn' || authMode === 'signUp' ? (
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
                ) : null}
                {authMode === 'resetVerify' || authMode === 'confirmVerify' ? (
                  <TextInput
                    value={otpCode}
                    onChangeText={setOtpCode}
                    placeholder="Code from the email"
                    placeholderTextColor={colors.textFaint}
                    keyboardType="number-pad"
                    maxLength={10}
                    style={[
                      styles.input,
                      { backgroundColor: colors.surface, color: colors.text },
                    ]}
                  />
                ) : null}
                {authMode === 'resetVerify' ? (
                  <TextInput
                    value={newPassword}
                    onChangeText={setNewPassword}
                    placeholder="New password"
                    placeholderTextColor={colors.textFaint}
                    secureTextEntry
                    style={[
                      styles.input,
                      { backgroundColor: colors.surface, color: colors.text },
                    ]}
                  />
                ) : null}
                <Pressable
                  onPress={
                    authMode === 'resetRequest'
                      ? requestReset
                      : authMode === 'resetVerify'
                        ? submitReset
                        : authMode === 'confirmVerify'
                          ? submitConfirm
                          : submitEmailAuth
                  }
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
                      {authMode === 'signIn'
                        ? 'Sign in'
                        : authMode === 'signUp'
                          ? 'Create account'
                          : authMode === 'resetRequest'
                            ? 'Send reset code'
                            : authMode === 'confirmVerify'
                              ? 'Confirm email'
                              : 'Set new password'}
                    </Text>
                  )}
                </Pressable>
                {authMode === 'signIn' ? (
                  <Pressable
                    onPress={() => switchMode('resetRequest')}
                    accessibilityRole="button">
                    <Text style={[styles.toggleText, { color: colors.textSecondary }]}>
                      Forgot password?
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() =>
                    switchMode(authMode === 'signIn' ? 'signUp' : 'signIn')
                  }
                  accessibilityRole="button">
                  <Text style={[styles.toggleText, { color: colors.textSecondary }]}>
                    {authMode === 'signIn'
                      ? 'No account? Create one'
                      : authMode === 'signUp'
                        ? 'Already have an account? Sign in'
                        : 'Back to sign in'}
                  </Text>
                </Pressable>
                {notice ? (
                  <Text style={[styles.notice, { color: colors.textSecondary }]}>{notice}</Text>
                ) : null}
              </>
            )}
          </>
        )}

        {/* ── Subscription + More — kept out of the signed-out sign-in flow so
            that screen stays clean (just the tagline + form). Shown once the
            user is signed in; upgrade/restore stay reachable via the paywall. */}
        {account ? (
        <>
        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>Subscription</Text>
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <InfoRow label="Plan" value={planSummary({ isPremium, isTrialing, tier })} />

          {isPremium || isTrialing ? (
            <Pressable
              onPress={onManageSub}
              accessibilityRole="button"
              style={[styles.subRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.subRowLabel, { color: colors.text }]}>Manage subscription</Text>
              <Ionicons name="open-outline" size={18} color={colors.textFaint} />
            </Pressable>
          ) : (
            <Pressable
              onPress={onUpgrade}
              accessibilityRole="button"
              style={[styles.subRow, { borderBottomColor: colors.border }]}>
              <Text style={[styles.subRowLabel, { color: colors.accent }]}>
                Upgrade to Parlez Premium
              </Text>
              <Ionicons name="chevron-forward" size={18} color={colors.accent} />
            </Pressable>
          )}

          <Pressable
            onPress={() => void onRefreshSub()}
            disabled={subBusy}
            accessibilityRole="button"
            style={[styles.subRow, { borderBottomColor: colors.border, opacity: subBusy ? 0.6 : 1 }]}>
            <Text style={[styles.subRowLabel, { color: colors.text }]}>
              Refresh subscription status
            </Text>
            {subBusy ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Ionicons name="refresh" size={18} color={colors.textFaint} />
            )}
          </Pressable>
        </View>

        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>More</Text>
        <View style={[styles.card, { backgroundColor: colors.surface }]}>
          <Pressable
            onPress={() => router.push('/privacy')}
            accessibilityRole="button"
            style={[styles.subRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.subRowLabel, { color: colors.text }]}>Privacy</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
          </Pressable>
        </View>
        </>
        ) : null}

        {/* ── Account management — destructive actions live at the very bottom,
            clearly separated from everything above (signed in only) ────────── */}
        {account ? (
          <View style={styles.accountActions}>
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
          </View>
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
  sectionTitle: {
    fontSize: FontSize.caption,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: Spacing.lg,
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: Spacing.md,
  },
  subRowLabel: { fontSize: FontSize.body, fontWeight: '500', flexShrink: 1 },
  accountActions: { marginTop: Spacing.xl },
});
