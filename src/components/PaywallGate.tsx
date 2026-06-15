/**
 * Conversation access hook. The conversation screen self-gates on this instead
 * of a redirecting wrapper: an entitled/trialing user — or a non-subscriber still
 * inside the free-taste allowance — gets the full live conversation; once that's
 * spent it flips to a read-only view (see src/app/conversation.tsx).
 *
 * Subscribes to freeSecondsUsed so crossing the allowance mid-session re-renders
 * the consumer and swaps it to read-only.
 */
import { FREE_TASTE_SECONDS, useSubscriptionStore } from '@/stores/subscriptionStore';

export function useCanConverse(): { canChat: boolean; ready: boolean } {
  const isPremium = useSubscriptionStore((s) => s.isPremium);
  const isTrialing = useSubscriptionStore((s) => s.isTrialing);
  const ready = useSubscriptionStore((s) => s.ready);
  const freeSecondsUsed = useSubscriptionStore((s) => s.freeSecondsUsed);
  const hasFreeTaste = freeSecondsUsed < FREE_TASTE_SECONDS;
  return { canChat: isPremium || isTrialing || hasFreeTaste, ready };
}
