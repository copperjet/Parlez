import { useSupabaseService } from '@/lib/env';

import type { ConversationService } from './conversation';
import { createMockService } from './mockService';
import { createSupabaseService } from './supabaseService';

/**
 * Returns the active conversation service. Uses the real Supabase-backed
 * providers when EXPO_PUBLIC_PARLEZ_SERVICE=supabase and the project is
 * configured; otherwise the scripted mock (no keys, no network).
 */
export function createConversationService(): ConversationService {
  return useSupabaseService ? createSupabaseService() : createMockService();
}

export type { ConversationService, SynthesizedSpeech, TurnInput } from './conversation';
