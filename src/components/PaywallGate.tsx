/**
 * Paywall gate — wraps any screen that requires an active `premium`
 * entitlement (or trial). Redirects to `/paywall` otherwise. The redirect is
 * live: RevenueCat's customerInfoUpdateListener flips the store mid-session,
 * which re-renders this component and bounces the user out.
 */
import { Redirect } from 'expo-router';
import type { ReactNode } from 'react';

import { useSubscriptionStore } from '@/stores/subscriptionStore';

export function useEntitlement(): {
  isPremium: boolean;
  isTrialing: boolean;
  loading: boolean;
  ready: boolean;
} {
  const isPremium = useSubscriptionStore((s) => s.isPremium);
  const isTrialing = useSubscriptionStore((s) => s.isTrialing);
  const loading = useSubscriptionStore((s) => s.loading);
  const ready = useSubscriptionStore((s) => s.ready);
  return { isPremium, isTrialing, loading, ready };
}

export function PaywallGate({ children }: { children: ReactNode }) {
  const { isPremium, isTrialing, ready } = useEntitlement();
  if (!ready) return null;
  if (!isPremium && !isTrialing) return <Redirect href={'/paywall' as never} />;
  return <>{children}</>;
}
