/**
 * Supabase client for optional account sync (spec §8.2: cloud sync is opt-in;
 * the app is fully functional without an account).
 *
 * `supabase` is null when the project is not configured — every account/sync
 * feature checks for that and degrades gracefully.
 */
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { ENV } from '@/lib/env';

export const supabase: SupabaseClient | null =
  ENV.supabaseUrl && ENV.supabaseAnonKey
    ? createClient(ENV.supabaseUrl, ENV.supabaseAnonKey, {
        auth: {
          storage: AsyncStorage,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
        },
      })
    : null;

/** True when account sync is available to offer the user. */
export const syncAvailable = supabase != null;
