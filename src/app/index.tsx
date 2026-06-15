import { Redirect } from 'expo-router';

import { useCanConverse } from '@/components/PaywallGate';
import { useAppStore } from '@/stores/appStore';

/**
 * Routing gate (spec §3.2): onboarding for first-timers, then conversation for
 * anyone allowed to converse — an entitled/trialing user OR a non-subscriber
 * still inside the free taste (value-first onboarding). Everyone else hits the
 * paywall. Subscription state hydrates from AsyncStorage cache before this
 * renders, so returning paying users go straight to /conversation even offline.
 */
export default function Index() {
  const hasOnboarded = useAppStore((s) => s.hasOnboarded);
  const { allowed, ready } = useCanConverse();

  if (!hasOnboarded) return <Redirect href="/onboarding" />;
  if (!ready) return null;
  if (!allowed) return <Redirect href={'/paywall' as never} />;
  return <Redirect href="/conversation" />;
}
