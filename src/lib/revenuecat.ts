/**
 * RevenueCat integration (Phase 1 monetization).
 *
 * Resolves a stable `appUserID` for both anonymous and signed-in users,
 * configures the SDK, and caches entitlement state in AsyncStorage so the
 * paywall gate can decide before the network round-trips.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Purchases, { LOG_LEVEL } from 'react-native-purchases';
import { Platform } from 'react-native';

import { getDb } from '@/lib/db';
import { supabase } from '@/lib/supabase';

const ANDROID_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY ?? '';
const IOS_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY ?? '';
const KV_ANON_ID = 'rc_anon_id';
const KV_AUTO_RESTORE = 'rc_auto_restore_done';
const CACHE_KEY = 'rc_cache_v1';

export interface CachedEntitlement {
  isPremium: boolean;
  isTrialing: boolean;
  /** Persisted so the soft daily-cap works offline before refresh() lands. */
  tier?: 'monthly' | 'annual' | 'lifetime' | null;
  fetchedAt: number;
}

let configured = false;
let resolvedAppUserId: string | null = null;

/** Random UUID v4 — avoids pulling in expo-crypto just for this. */
function uuidv4(): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function readKv(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM kv WHERE key = ?',
      key,
    );
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function writeKv(key: string, value: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.runAsync(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  } catch {
    // best-effort
  }
}

async function getAnonId(): Promise<string> {
  const existing = await readKv(KV_ANON_ID);
  if (existing && existing.trim()) return existing.trim();
  const fresh = uuidv4();
  await writeKv(KV_ANON_ID, fresh);
  return fresh;
}

async function resolveAppUserId(): Promise<string> {
  if (supabase) {
    try {
      const { data } = await supabase.auth.getUser();
      if (data.user?.id) return data.user.id;
    } catch {
      // fall through to anon id
    }
  }
  return getAnonId();
}

/**
 * Initialise the RevenueCat SDK. Idempotent. Never throws — on failure the
 * entitlement store stays at its cached values and the gate degrades to
 * "show paywall but allow Restore".
 */
export async function initRevenueCat(): Promise<void> {
  if (configured) return;
  const apiKey = Platform.OS === 'ios' ? IOS_KEY : ANDROID_KEY;
  if (!apiKey) return;
  try {
    Purchases.setLogLevel(__DEV__ ? LOG_LEVEL.WARN : LOG_LEVEL.ERROR);
    const appUserID = await resolveAppUserId();
    Purchases.configure({ apiKey, appUserID });
    resolvedAppUserId = appUserID;
    configured = true;
  } catch {
    // Leave configured=false; later refresh() calls become no-ops via isConfigured().
  }
}

export function isConfigured(): boolean {
  return configured;
}

/**
 * The caller-id (RevenueCat appUserID) used to attribute usage rows
 * server-side. Resolved during `initRevenueCat()`; falls back to a fresh
 * lookup if RC failed to configure (e.g. missing public key in dev).
 */
export async function getCallerId(): Promise<string | null> {
  if (resolvedAppUserId) return resolvedAppUserId;
  try {
    const id = await resolveAppUserId();
    resolvedAppUserId = id;
    return id;
  } catch {
    return null;
  }
}

export async function getCachedEntitlement(): Promise<CachedEntitlement | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedEntitlement>;
    if (
      typeof parsed.isPremium !== 'boolean' ||
      typeof parsed.isTrialing !== 'boolean' ||
      typeof parsed.fetchedAt !== 'number'
    ) {
      return null;
    }
    const tier =
      parsed.tier === 'monthly' ||
      parsed.tier === 'annual' ||
      parsed.tier === 'lifetime'
        ? parsed.tier
        : null;
    return { ...(parsed as CachedEntitlement), tier };
  } catch {
    return null;
  }
}

export async function writeCachedEntitlement(c: CachedEntitlement): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    // best-effort
  }
}

export async function clearCachedEntitlement(): Promise<void> {
  try {
    await AsyncStorage.removeItem(CACHE_KEY);
  } catch {
    // best-effort
  }
  await writeKv(KV_ANON_ID, '');
}

/**
 * One-shot silent restore guard. After a reinstall the anon ID is regenerated,
 * so a paying user looks Free until `restorePurchases()` re-syncs the store
 * receipt — the flag limits that automatic sync to once per install.
 */
export async function hasAutoRestored(): Promise<boolean> {
  return (await readKv(KV_AUTO_RESTORE)) === 'true';
}

export async function markAutoRestored(): Promise<void> {
  await writeKv(KV_AUTO_RESTORE, 'true');
}

/**
 * Alias a freshly-signed-in Supabase identity onto the existing anonymous
 * RevenueCat user — purchases transfer automatically.
 */
export async function aliasToSupabase(supabaseUserId: string): Promise<void> {
  if (!configured) return;
  try {
    await Purchases.logIn(supabaseUserId);
    resolvedAppUserId = supabaseUserId;
  } catch {
    // best-effort
  }
}
