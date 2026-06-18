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
  INTRO_ELIGIBILITY_STATUS,
  type CustomerInfo,
  type PurchasesEntitlementInfo,
  type PurchasesOffering,
  type PurchasesPackage,
} from 'react-native-purchases';

import {
  clearCachedEntitlement,
  getCachedEntitlement,
  hasAutoRestored,
  isConfigured,
  markAutoRestored,
  writeCachedEntitlement,
} from '@/lib/revenuecat';

const ENTITLEMENT_ID = 'premium';
const USAGE_KEY = 'usage_today_v1';
const FREE_USAGE_KEY = 'free_usage_v1';

/**
 * Free-taste allowance: lifetime conversation seconds a never-subscribed user
 * gets before the paywall. 600s = 10 min = the daily streak goal, so the first
 * free session also lights their first flame. MUST match FREE_TASTE_MS on the
 * server (supabase/functions/turn/index.ts) — the server is authoritative; this
 * mirror only drives routing so the paywall doesn't flash a round-trip late.
 */
export const FREE_TASTE_SECONDS = 600;

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
  /** Sticky: true once the user has EVER been premium on this install. Drives the
   *  locked-screen copy split (churned subscriber vs never-paid free-taste user). */
  wasEverPremium: boolean;
  tier: Tier;
  entitlement: PurchasesEntitlementInfo | null;
  offerings: PurchasesOffering | null;
  /**
   * Per-product intro-trial eligibility for THIS user, as computed by RevenueCat
   * (which reflects the store's once-per-account rule). Keyed by product
   * identifier. A value of `false` means RC is confident the user is INELIGIBLE
   * — the store will not grant the trial, so the paywall must not advertise one.
   * Missing key or `true` means show the catalog trial: a genuine first-timer, or
   * an UNKNOWN result we don't punish (hiding on UNKNOWN would kill first-timer
   * conversion on Android, where eligibility often can't be resolved client-side).
   */
  trialEligibleByProduct: Record<string, boolean>;
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

  /**
   * Lifetime conversation seconds — the free-taste meter for non-subscribers.
   * Accrues on every turn (mirrors the server's lifetime elapsed_ms), so a
   * never-subscribed user is gated once they cross FREE_TASTE_SECONDS and a
   * churned subscriber — already well past it — never gets a fresh free run.
   */
  freeSecondsUsed: number;

  hydrateFromCache: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Recompute per-user intro-trial eligibility for the offering's subscriptions. */
  refreshTrialEligibility: (offering: PurchasesOffering | null) => Promise<void>;
  purchase: (pkg: PurchasesPackage) => Promise<boolean>;
  restore: () => Promise<boolean>;
  logOutAndReset: () => Promise<void>;
  applyCustomerInfo: (info: CustomerInfo) => void;

  // Usage actions.
  hydrateUsageFromCache: () => Promise<void>;
  hydrateFreeUsageFromCache: () => Promise<void>;
  /** Mark the free taste fully spent — flips the conversation to read-only. Used
   *  when the server (authoritative) denies a turn the client meter hadn't yet
   *  caught as exhausted, so both agree and the read-only flow takes over. */
  exhaustFreeTaste: () => void;
  /** Reset ONLY the free-taste meter — used when a different account takes over the
   *  device, so the new identity's gate reflects its own server usage, not the
   *  previous user's carried-over meter. Distinct from logOutAndReset, which also
   *  tears down the RevenueCat session (wrong here: the new identity is already
   *  aliased in). The server stays authoritative, so a fresh 0 self-corrects to a
   *  403 on the first turn if that identity is already past its free taste. */
  resetFreeUsage: () => void;
  resetDailyIfNewDay: () => void;
  recordTurnElapsed: (ms: number) => void;
  setCapBlocked: (opts: { tier: Exclude<Tier, null>; capSeconds: number }) => void;
  clearCapBlocked: () => void;
}

const TIER_LABEL: Record<Exclude<Tier, null>, string> = {
  monthly: 'Monthly',
  annual: 'Annual',
  lifetime: 'Lifetime',
};

/** Human-readable plan summary shared by Settings and the Account screen. */
export function planSummary(p: {
  isPremium: boolean;
  isTrialing: boolean;
  tier: Tier;
}): string {
  if (!p.isPremium) return 'Free';
  if (p.isTrialing) return 'Free trial';
  return p.tier ? `Premium · ${TIER_LABEL[p.tier]}` : 'Premium';
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

async function persistFreeUsage(seconds: number): Promise<void> {
  try {
    await AsyncStorage.setItem(FREE_USAGE_KEY, String(Math.max(0, Math.round(seconds))));
  } catch {
    // best-effort
  }
}

async function readFreeUsage(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(FREE_USAGE_KEY);
    const n = Number(raw ?? '0');
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  } catch {
    return 0;
  }
}

let listenerRegistered = false;

export const useSubscriptionStore = create<SubscriptionStore>((set, get) => ({
  isPremium: false,
  isTrialing: false,
  wasEverPremium: false,
  tier: null,
  entitlement: null,
  offerings: null,
  trialEligibleByProduct: {},
  loading: false,
  ready: false,
  error: null,
  lastFetchedAt: null,
  usageTodaySeconds: 0,
  usageDay: todayLocal(),
  tierCapSeconds: null,
  capBlocked: false,
  capBlockedTier: null,
  freeSecondsUsed: 0,

  hydrateFromCache: async () => {
    const cached = await getCachedEntitlement();
    if (cached) {
      const tier = cached.tier ?? null;
      set({
        isPremium: cached.isPremium,
        isTrialing: cached.isTrialing,
        wasEverPremium: cached.everPremium ?? cached.isPremium,
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
      // Snapshot the cached/hydrated truth BEFORE we touch it, so we can tell a
      // genuine downgrade from a transient empty customerInfo.
      const cachedPremium = get().isPremium;
      const [info, offers] = await Promise.all([
        Purchases.getCustomerInfo(),
        Purchases.getOfferings(),
      ]);
      set({ offerings: offers.current ?? null });
      // Fire-and-forget: eligibility never gates routing, only paywall copy, so
      // it must not block the entitlement resolution below.
      void get().refreshTrialEligibility(offers.current ?? null);

      // Self-heal: if the cache said premium but this fetch reports nothing, do
      // NOT downgrade on faith — a flapping app-user-id or a slow store handoff
      // momentarily returns an empty customerInfo and would bounce a paying user
      // to the paywall on every return. Re-sync the store receipt first and
      // commit whichever result actually grants the entitlement. Peeking the
      // result (readEntitlement) before applyCustomerInfo avoids a paywall flash.
      if (cachedPremium && !readEntitlement(info).isPremium) {
        try {
          const restored = await Purchases.restorePurchases();
          get().applyCustomerInfo(
            readEntitlement(restored).isPremium ? restored : info,
          );
        } catch {
          // Receipt re-sync failed (offline, store hiccup) — keep the cached
          // entitlement rather than punishing a paying user for a transient gap.
        }
      } else {
        get().applyCustomerInfo(info);
      }
      set({ loading: false, ready: true });

      // Reinstall recovery (once per install): a fresh anonymous ID has no
      // entitlement even if the store account has an active subscription —
      // silently re-sync the receipt so paying users never see the paywall.
      // iOS may show one App Store sign-in prompt; accepted trade-off. Only the
      // never-cached-premium path needs this; the cached-premium case is already
      // handled above on every refresh.
      if (!get().isPremium && !cachedPremium && !(await hasAutoRestored())) {
        try {
          const restored = await Purchases.restorePurchases();
          get().applyCustomerInfo(restored);
        } catch {
          // Best-effort — the manual refresh in Account remains the fallback.
        } finally {
          await markAutoRestored();
        }
      }
    } catch (e) {
      set({
        loading: false,
        ready: true,
        error: e instanceof Error ? e.message : 'fetch_failed',
      });
    }
  },

  refreshTrialEligibility: async (offering) => {
    if (!isConfigured() || !offering) return;
    // Only auto-renewing subscriptions can carry an intro trial — lifetime can't,
    // and the catalog already has no introPrice for it.
    const ids = offering.availablePackages
      .filter((p) => p.packageType === 'MONTHLY' || p.packageType === 'ANNUAL')
      .map((p) => p.product.identifier);
    if (ids.length === 0) return;
    try {
      const result = await Purchases.checkTrialOrIntroductoryPriceEligibility(ids);
      const map: Record<string, boolean> = {};
      for (const [id, e] of Object.entries(result)) {
        // Suppress trial copy ONLY on an explicit INELIGIBLE (RC is confident the
        // store won't grant it — the once-per-account churned/reinstall case).
        // ELIGIBLE, UNKNOWN and NO_INTRO_OFFER all leave trial copy to the catalog
        // check, so a genuine first-timer is never denied the offer over an
        // unresolvable Android eligibility lookup.
        map[id] =
          e.status !== INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_INELIGIBLE;
      }
      set({ trialEligibleByProduct: map });
    } catch {
      // Best-effort: leave the map as-is. A missing entry shows the catalog trial,
      // the same safe-for-first-timers default as UNKNOWN.
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
      // Log-out switches to a fresh anonymous RevenueCat id, for which the server
      // sees zero lifetime usage and re-grants the free taste — so clear the local
      // mirror too, keeping client and server in agreement.
      await AsyncStorage.removeItem(FREE_USAGE_KEY);
    } catch {
      // best-effort
    }
    set({
      isPremium: false,
      isTrialing: false,
      wasEverPremium: false,
      tier: null,
      entitlement: null,
      trialEligibleByProduct: {},
      lastFetchedAt: null,
      usageTodaySeconds: 0,
      usageDay: todayLocal(),
      tierCapSeconds: null,
      capBlocked: false,
      capBlockedTier: null,
      freeSecondsUsed: 0,
    });
  },

  applyCustomerInfo: (info) => {
    const next = readEntitlement(info);
    const fetchedAt = Date.now();
    const tierCap = capForTier(next.tier);
    // Sticky — only ever flips false→true, so a transient empty customerInfo or a
    // churn can't erase the fact that this user paid at some point this install.
    const everPremium = get().wasEverPremium || next.isPremium;
    set({
      ...next,
      wasEverPremium: everPremium,
      tierCapSeconds: tierCap,
      lastFetchedAt: fetchedAt,
    });
    void writeCachedEntitlement({
      isPremium: next.isPremium,
      isTrialing: next.isTrialing,
      tier: next.tier,
      everPremium,
      fetchedAt,
    });
  },

  hydrateFreeUsageFromCache: async () => {
    set({ freeSecondsUsed: await readFreeUsage() });
  },

  exhaustFreeTaste: () => {
    set({ freeSecondsUsed: FREE_TASTE_SECONDS });
    void persistFreeUsage(FREE_TASTE_SECONDS);
  },

  resetFreeUsage: () => {
    set({ freeSecondsUsed: 0 });
    void AsyncStorage.removeItem(FREE_USAGE_KEY);
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
    // Free-taste meter (lifetime). Accrue on every turn — same as the server's
    // lifetime elapsed_ms — so the gate mirrors the server exactly: a fresh user
    // is let in until they cross FREE_TASTE_SECONDS, and a churned subscriber
    // (already far past it) is never handed a second free run.
    const free = get().freeSecondsUsed + seconds;
    set({ freeSecondsUsed: free });
    void persistFreeUsage(free);
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
