import { Redirect } from 'expo-router';

import { useAppStore } from '@/stores/appStore';

/**
 * Routing gate (spec §3.2): returning users go straight to the conversation,
 * first-time users start onboarding. Persistence of `hasOnboarded` across
 * launches arrives with the SQLite store in Phase 6.
 */
export default function Index() {
  const hasOnboarded = useAppStore((s) => s.hasOnboarded);
  return <Redirect href={hasOnboarded ? '/conversation' : '/onboarding'} />;
}
