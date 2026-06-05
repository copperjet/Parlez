import { Redirect } from 'expo-router';

import { useAppStore } from '@/stores/appStore';
import { useSubscriptionStore } from '@/stores/subscriptionStore';

/**
 * Routing gate (spec §3.2): onboarding for first-timers, paywall for users
 * without an active `premium` entitlement, conversation for everyone else.
 * Subscription state hydrates from AsyncStorage cache before this renders, so
 * returning paying users go straight to /conversation even offline.
 */
export default function Index() {
  const hasOnboarded = useAppStore((s) => s.hasOnboarded);
  const isPremium = useSubscriptionStore((s) => s.isPremium);
  const isTrialing = useSubscriptionStore((s) => s.isTrialing);
  const ready = useSubscriptionStore((s) => s.ready);

  if (!hasOnboarded) return <Redirect href="/onboarding" />;
  if (!ready) return null;
  if (!isPremium && !isTrialing) return <Redirect href={'/paywall' as never} />;
  return <Redirect href="/conversation" />;
}
