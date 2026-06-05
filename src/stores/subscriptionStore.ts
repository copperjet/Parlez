/**
 * Subscription / entitlement state. Mirrors `appStore` patterns (Zustand,
 * fire-and-forget persistence). The single source of truth for the paywall
 * gate; RevenueCat's `customerInfoUpdateListener` keeps it live, so a mid-
 * session trial expiry flips `isTrialing` and the gate redirects.
 *
 * Phase 2: also owns the local rolling-day usage counter that pre-empts a
 * `turn` request before the server says no — soft cap for UX. The server
 * remains the source of truth: a 402 from `turn` flips `capBlocked` even if
 * the local counter disagrees.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import Purchases, {
  type CustomerInfo,
  type PurchasesEntitlementInfo,
  type PurchasesOffering,
  type PurchasesPackage,
} from 'react-native-purchases';

import {
  clearCachedEntitlement,
  getCachedEntitlement,
  isConfigured,
  writeCachedEntitlement,
} from '@/lib/revenuecat';

const ENTITLEMENT_ID = 'premium';
const USAGE_KEY = 'usage_today_v1';

export type Tier = 'monthly' | 'annual' | 'lifetime' | null;

/** Tier caps in seconds. Mirrors `supabase/functions/_shared/caps.ts`. */
const TIER_CAP_SECONDS: Record<Exclude<Tier, null>, number | null> = {
  monthly: 1800,
  annual: 5400,
  lifetime: null,
};

interface PersistedUsage {
  day: string;          // YYYY-MM-DD local
  seconds: number;
}

interface SubscriptionStore {
  isPremium: boolean;
  isTrialing: boolean;
  tier: Tier;
  entitlement: PurchasesEntitlementInfo | null;
  offerings: PurchasesOffering | null;
  loading: boolean;
  /** True once we've hydrated from cache OR refresh() has returned. Routing
   * waits for this to avoid a flash of paywall for paying users. */
  ready: boolean;
  error: string | null;
  lastFetchedAt: number | null;

  // Phase 2 — local rolling-day usage + cap state.
  usageTodaySeconds: number;
  /** Local calendar day (YYYY-MM-DD) the counter belongs to. Enables a
   * synchronous new-day reset without awaiting AsyncStorage. */
  usageDay: string;
  /** Cap for the user's current tier in seconds; null = unlimited. */
  tierCapSeconds: number | null;
  /** True when the most recent turn was rejected by the cap (client OR server). */
  capBlocked: boolean;
  capBlockedTier: Exclude<Tier, null> | null;

  hydrateFromCache: () => Promise<void>;
  refresh: () => Promise<void>;
  purchase: (pkg: PurchasesPackage) => Promise<boolean>;
  restore: () => Promise<boolean>;
  logOutAndReset: () => Promise<void>;
  applyCustomerInfo: (info: CustomerInfo) => void;

  // Usage actions.
  hydrateUsageFromCache: () => Promise<void>;
  resetDailyIfNewDay: () => void;
  recordTurnElapsed: (ms: number) => void;
  setCapBlocked: (opts: { tier: Exclude<Tier, null>; capSeconds: number }) => void;
  clearCapBlocked: () => void;
}

function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function deriveTier(productId: string | undefined | null): Tier {
  if (!productId) return null;
  const p = productId.toLowerCase();
  if (p.includes('lifetime')) return 'lifetime';
  if (p.includes('annual') || p.includes('year')) return 'annual';
  if (p.includes('monthly') || p.includes('month')) return 'monthly';
  return null;
}

function readEntitlement(info: CustomerInfo): {
  isPremium: boolean;
  isTrialing: boolean;
  tier: Tier;
  entitlement: PurchasesEntitlementInfo | null;
} {
  const ent = info.entitlements.active[ENTITLEMENT_ID] ?? null;
  const isPremium = ent?.isActive === true;
  const isTrialing = isPremium && ent?.periodType === 'TRIAL';
  const tier = deriveTier(ent?.productIdentifier);
  return { isPremium, isTrialing, tier, entitlement: ent };
}

function capForTier(tier: Tier): number | null {
  if (!tier) return null;
  return TIER_CAP_SECONDS[tier];
}

async function persistUsage(p: PersistedUsage): Promise<void> {
  try {
    await AsyncStorage.setItem(USAGE_KEY, JSON.stringify(p));
  } catch {
    // best-effort
  }
}

async function readPersistedUsage(): Promise<PersistedUsage | null> {
  try {
    const raw = await AsyncStorage.getItem(USAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedUsage>;
    if (typeof parsed.day !== 'string' || typeof parsed.seconds !== 'number') return null;
    return { day: parsed.day, seconds: parsed.seconds };
  } catch {
    return null;
  }
}

let listenerRegistered = false;

export const useSubscriptionStore = create<SubscriptionStore>((set, get) => ({
  isPremium: false,
  isTrialing: false,
  tier: null,
  entitlement: null,
  offerings: null,
  loading: false,
  ready: false,
  error: null,
  lastFetchedAt: null,
  usageTodaySeconds: 0,
  usageDay: todayLocal(),
  tierCapSeconds: null,
  capBlocked: false,
  capBlockedTier: null,

  hydrateFromCache: async () => {
    const cached = await getCachedEntitlement();
    if (cached) {
      const tier = cached.tier ?? null;
      set({
        isPremium: cached.isPremium,
        isTrialing: cached.isTrialing,
        tier,
        tierCapSeconds: capForTier(tier),
        lastFetchedAt: cached.fetchedAt,
      });
    }
    set({ ready: true });
  },

  refresh: async () => {
    if (!isConfigured()) {
      set({ ready: true });
      return;
    }
    set({ loading: true, error: null });
    try {
      if (!listenerRegistered) {
        listenerRegistered = true;
        Purchases.addCustomerInfoUpdateListener((info) => {
          get().applyCustomerInfo(info);
        });
      }
      const [info, offers] = await Promise.all([
        Purchases.getCustomerInfo(),
        Purchases.getOfferings(),
      ]);
      get().applyCustomerInfo(info);
      set({
        offerings: offers.current ?? null,
        loading: false,
        ready: true,
      });
    } catch (e) {
      set({
        loading: false,
        ready: true,
        error: e instanceof Error ? e.message : 'fetch_failed',
      });
    }
  },

  purchase: async (pkg) => {
    if (!isConfigured()) return false;
    set({ loading: true, error: null });
    try {
      const { customerInfo } = await Purchases.purchasePackage(pkg);
      get().applyCustomerInfo(customerInfo);
      set({ loading: false });
      return get().isPremium;
    } catch (e) {
      const userCancelled =
        e != null && typeof e === 'object' && 'userCancelled' in e
          ? (e as { userCancelled?: boolean }).userCancelled === true
          : false;
      set({
        loading: false,
        error: userCancelled ? null : e instanceof Error ? e.message : 'purchase_failed',
      });
      return false;
    }
  },

  restore: async () => {
    if (!isConfigured()) return false;
    set({ loading: true, error: null });
    try {
      const info = await Purchases.restorePurchases();
      get().applyCustomerInfo(info);
      set({ loading: false });
      return get().isPremium;
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : 'restore_failed',
      });
      return false;
    }
  },

  logOutAndReset: async () => {
    await clearCachedEntitlement();
    if (isConfigured()) {
      try {
        await Purchases.logOut();
      } catch {
        // Logging out an already-anonymous user throws; ignore.
      }
    }
    try {
      await AsyncStorage.removeItem(USAGE_KEY);
    } catch {
      // best-effort
    }
    set({
      isPremium: false,
      isTrialing: false,
      tier: null,
      entitlement: null,
      lastFetchedAt: null,
      usageTodaySeconds: 0,
      usageDay: todayLocal(),
      tierCapSeconds: null,
      capBlocked: false,
      capBlockedTier: null,
    });
  },

  applyCustomerInfo: (info) => {
    const next = readEntitlement(info);
    const fetchedAt = Date.now();
    const tierCap = capForTier(next.tier);
    set({
      ...next,
      tierCapSeconds: tierCap,
      lastFetchedAt: fetchedAt,
    });
    void writeCachedEntitlement({
      isPremium: next.isPremium,
      isTrialing: next.isTrialing,
      tier: next.tier,
      fetchedAt,
    });
  },

  hydrateUsageFromCache: async () => {
    const today = todayLocal();
    const p = await readPersistedUsage();
    if (!p || p.day !== today) {
      // No record, or a new day — start fresh.
      await persistUsage({ day: today, seconds: 0 });
      set({ usageTodaySeconds: 0, usageDay: today });
      return;
    }
    set({ usageTodaySeconds: p.seconds, usageDay: p.day });
  },

  resetDailyIfNewDay: () => {
    // Synchronous: compare the in-memory day so the caller can read the reset
    // state immediately on the same tick (no AsyncStorage await race at the
    // midnight boundary when the app is left open). Persist in the background.
    const today = todayLocal();
    if (get().usageDay !== today) {
      set({
        usageTodaySeconds: 0,
        usageDay: today,
        capBlocked: false,
        capBlockedTier: null,
      });
      void persistUsage({ day: today, seconds: 0 });
    }
  },

  recordTurnElapsed: (ms) => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds === 0) return;
    const today = todayLocal();
    // A turn may complete after midnight — roll over rather than add to yesterday.
    const base = get().usageDay === today ? get().usageTodaySeconds : 0;
    const next = base + seconds;
    set({ usageTodaySeconds: next, usageDay: today });
    void persistUsage({ day: today, seconds: next });
  },

  setCapBlocked: ({ tier, capSeconds }) => {
    set({
      capBlocked: true,
      capBlockedTier: tier,
      tierCapSeconds: capSeconds,
    });
  },

  clearCapBlocked: () => {
    set({ capBlocked: false, capBlockedTier: null });
  },
}));
