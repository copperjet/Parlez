/**
 * Paywall gate — wraps any screen that requires an active `premium`
 * entitlement (or trial). Redirects to `/paywall` otherwise. The redirect is
 * live: RevenueCat's customerInfoUpdateListener flips the store mid-session,
 * which re-renders this component and bounces the user out.
 */
import { Redirect } from 'expo-router';
import type { ReactNode } from 'react';

import { FREE_TASTE_SECONDS, useSubscriptionStore } from '@/stores/subscriptionStore';

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

/**
 * True when the user may use the app right now: an entitled (or trialing) user,
 * OR a non-subscriber still inside the free-taste allowance. Subscribes to
 * freeSecondsUsed so crossing the allowance mid-session re-renders the gate and
 * bounces them to the paywall.
 */
export function useCanConverse(): { allowed: boolean; ready: boolean } {
  const isPremium = useSubscriptionStore((s) => s.isPremium);
  const isTrialing = useSubscriptionStore((s) => s.isTrialing);
  const ready = useSubscriptionStore((s) => s.ready);
  const freeSecondsUsed = useSubscriptionStore((s) => s.freeSecondsUsed);
  const hasFreeTaste = freeSecondsUsed < FREE_TASTE_SECONDS;
  return { allowed: isPremium || isTrialing || hasFreeTaste, ready };
}

export function PaywallGate({ children }: { children: ReactNode }) {
  const { allowed, ready } = useCanConverse();
  if (!ready) return null;
  if (!allowed) return <Redirect href={'/paywall?reason=free' as never} />;
  return <>{children}</>;
}
