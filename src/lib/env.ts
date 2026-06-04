/**
 * Build-time environment. Expo inlines `process.env.EXPO_PUBLIC_*` values into
 * the bundle. Copy `.env.example` to `.env` and fill these in to switch from
 * the mock service to the real Supabase-backed providers.
 */
export const ENV = {
  /** Supabase project URL, e.g. https://xxxx.supabase.co */
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? '',
  /** Supabase anon (public) key. */
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '',
  /** Which conversation service to use: 'mock' (default) or 'supabase'. */
  service: (process.env.EXPO_PUBLIC_PARLEZ_SERVICE ?? 'mock') as 'mock' | 'supabase',
};

/** True when Supabase is configured and selected. */
export const useSupabaseService =
  ENV.service === 'supabase' && !!ENV.supabaseUrl && !!ENV.supabaseAnonKey;

/** Base URL for the Edge Functions (the BFF layer, spec §7.2). */
export function functionsBase(): string {
  return `${ENV.supabaseUrl.replace(/\/$/, '')}/functions/v1`;
}
