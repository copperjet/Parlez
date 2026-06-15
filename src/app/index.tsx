import { Redirect } from 'expo-router';

import { useAppStore } from '@/stores/appStore';
import { useSubscriptionStore } from '@/stores/subscriptionStore';

/**
 * Routing gate (spec §3.2): onboarding for first-timers, then the conversation
 * for everyone else. The conversation screen self-manages access — full chat for
 * an entitled/trialing user or one still inside the free taste, and a read-only
 * view with an upgrade bar once that's spent — so we no longer route to the
 * paywall here. Subscription state hydrates from cache before this renders.
 */
export default function Index() {
  const hasOnboarded = useAppStore((s) => s.hasOnboarded);
  const ready = useSubscriptionStore((s) => s.ready);

  if (!hasOnboarded) return <Redirect href="/onboarding" />;
  if (!ready) return null;
  return <Redirect href="/conversation" />;
}
