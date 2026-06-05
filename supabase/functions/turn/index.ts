/**
 * `turn` Edge Function — the BFF for one conversational turn (spec §7.2).
 *
 * Receives the user's audio (or text) plus conversation context, runs Whisper
 * for STT, builds Marie's system prompt, calls Claude, and returns the
 * structured turn result. Voice audio is processed in memory and never stored
 * (spec §8).
 *
 * Set PARLEZ_MOCK=true to stub the providers for end-to-end testing without keys.
 *
 * Phase 2 monetization: every call resolves the caller (JWT or anon RC id),
 * checks the tiered daily cap (`usage_daily`) and writes per-event cost rows
 * into `usage_events` (non-blocking).
 */
import { corsHeaders, json } from '../_shared/cors.ts';
import {
  buildConsolidationPrompt,
  buildMessages,
  buildSystemPrompt,
  type PromptContext,
  type TurnMode,
} from '../_shared/prompt.ts';
import { resolveCaller, type Caller } from '../_shared/caller.ts';
import { serviceClient } from '../_shared/db.ts';
import { loadTier, loadTodayElapsedMs, tierCapSeconds } from '../_shared/caps.ts';
import {
  estimateClaudeMicrocents,
  estimateWhisperMicrocents,
  type ClaudeUsage,
} from '../_shared/pricing.ts';

interface AiResult {
  speechText: string;
  translation: string;
  corrections: { original: string; corrected: string; gloss?: string }[];
  profileNotes: string[];
  levelSignal: 'up' | 'hold' | 'down';
  learnerName: string | null;
  interests: string[];
}

function normalizeContext(raw: unknown): PromptContext {
  const c = (raw ?? {}) as Partial<PromptContext>;
  const interests = Array.isArray(c.interests)
    ? (c.interests as unknown[])
        .filter((i): i is string => typeof i === 'string')
        .map((i) => i.trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];
  return {
    level: c.level === 'A' || c.level === 'C' ? c.level : 'B',
    profileSummary: typeof c.profileSummary === 'string' ? c.profileSummary : '',
    gapSinceLastSession:
      typeof c.gapSinceLastSession === 'number' ? c.gapSinceLastSession : null,
    history: Array.isArray(c.history) ? c.history : [],
    personaName:
      typeof c.personaName === 'string' && c.personaName.trim()
        ? c.personaName.trim()
        : 'Marie',
    learnerName:
      typeof c.learnerName === 'string' && c.learnerName.trim()
        ? c.learnerName.trim()
        : null,
    interests,
    streakDays:
      typeof c.streakDays === 'number' && c.streakDays > 0
        ? Math.floor(c.streakDays)
        : 0,
  };
}

/**
 * A short French biasing hint for Whisper: the partner's name, the learner's
 * name (when known), plus the last couple of turns. Nudges the model toward
 * the conversation's vocabulary and spelling, improving accuracy on names and
 * recently-used words (spec §6.1).
 */
function transcriptionPrompt(ctx: PromptContext): string {
  const recent = ctx.history
    .slice(-2)
    .map((m) => m.text)
    .filter(Boolean)
    .join(' ');
  const learnerHint = ctx.learnerName?.trim()
    ? `L'apprenant s'appelle ${ctx.learnerName.trim()}.`
    : '';
  return [`Conversation en français avec ${ctx.personaName}.`, learnerHint, recent]
    .filter(Boolean)
    .join(' ')
    .slice(0, 900);
}

interface WhisperResult {
  text: string;
  /** Audio duration in milliseconds (from Whisper when available; else byte-rate estimate). */
  durationMs: number;
  bytes: number;
}

/** Rough cross-format byte→ms estimate; only used when Whisper omits duration. */
function estimateDurationMsFromBytes(bytes: number): number {
  // ~16 kB/sec covers compressed (Opus/AAC) up to PCM-16 mono 16k roughly.
  return Math.max(0, Math.round((bytes / 16_000) * 1000));
}

/**
 * Server-authoritative conversation-time estimate from a character count.
 * French TTS / speech ≈ 14 chars/sec. Used to attribute *conversation* seconds
 * to a turn (user speech + Marie's reply) — the measure the daily cap is about.
 * Deliberately NOT fn wall-clock: that's compute time and would never bind the
 * cap, leaving it sideload-bypassable.
 */
function estimateSpeechMs(chars: number): number {
  return Math.max(0, Math.round((chars / 14) * 1000));
}

/** Whisper STT — French, with English code-switch tolerance (spec §6.1). */
async function transcribe(audio: File, ctx: PromptContext): Promise<WhisperResult> {
  const key = Deno.env.get('OPENAI_API_KEY');
  if (!key) throw new Error('OPENAI_API_KEY not set');

  const fd = new FormData();
  // Keep the uploaded file's extension — Whisper uses it to detect the format.
  fd.append('file', audio, audio.name || 'turn.wav');
  // gpt-4o-mini-transcribe is more accurate than whisper-1 and accepts the same
  // multipart endpoint, plus a context prompt + temperature. Override via env.
  const model = Deno.env.get('OPENAI_STT_MODEL') ?? 'gpt-4o-mini-transcribe';
  fd.append('model', model);
  fd.append('language', 'fr');
  // verbose_json returns `duration` (seconds) when the model supports it; the
  // gpt-4o transcribe models do not, so we fall back to a byte-rate estimate.
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  // Bias the transcript toward this conversation's name + recent vocabulary.
  fd.append('prompt', transcriptionPrompt(ctx));

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  const bytes = audio.size ?? 0;
  const durationMs =
    typeof data.duration === 'number'
      ? Math.round(data.duration * 1000)
      : estimateDurationMsFromBytes(bytes);
  return { text, durationMs, bytes };
}

/** Pull the JSON object out of Claude's text output and coerce it. */
function parseAi(text: string): AiResult {
  let parsed: Record<string, unknown> = {};
  try {
    const match = text.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : {};
  } catch {
    parsed = {};
  }
  const corrections = Array.isArray(parsed.corrections)
    ? (parsed.corrections as AiResult['corrections'])
        .filter((c) => c && c.original && c.corrected)
        .slice(0, 2)
    : [];
  const profileNotes = Array.isArray(parsed.profileNotes)
    ? (parsed.profileNotes as unknown[]).filter((n): n is string => typeof n === 'string')
    : [];
  const sig = parsed.levelSignal;
  const learnerName =
    typeof parsed.learnerName === 'string' && parsed.learnerName.trim()
      ? parsed.learnerName.trim()
      : null;
  const interests = Array.isArray(parsed.interests)
    ? Array.from(
        new Set(
          (parsed.interests as unknown[])
            .filter((i): i is string => typeof i === 'string')
            .map((i) => i.trim())
            .filter(Boolean),
        ),
      ).slice(0, 8)
    : [];
  return {
    speechText: typeof parsed.speechText === 'string' ? parsed.speechText : '',
    translation: typeof parsed.translation === 'string' ? parsed.translation : '',
    corrections,
    profileNotes,
    levelSignal: sig === 'up' || sig === 'down' ? sig : 'hold',
    learnerName,
    interests,
  };
}

interface ClaudeResult {
  ai: AiResult;
  usage: ClaudeUsage;
}

/** Claude generates Marie's structured response (spec §5, §7.5). */
async function generate(
  ctx: PromptContext,
  mode: TurnMode,
  simpler: boolean,
  transcript: string,
): Promise<ClaudeResult> {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const model = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5';

  // The system prompt is split into a stable (cacheable) half and a volatile
  // per-turn half. The stable half goes into `system` with cache_control; the
  // volatile half rides on the first user message so it does not bust the
  // cache (spec §7.5 — extension for cost control at scale).
  const { stable, volatile } = buildSystemPrompt(ctx, mode, simpler);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system: [
        {
          type: 'text',
          text: stable,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: buildMessages(ctx, mode, transcript, volatile),
    }),
  });
  if (!res.ok) throw new Error(`claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content ?? [])
    .filter((c: { type: string }) => c.type === 'text')
    .map((c: { text: string }) => c.text)
    .join('');
  const usage: ClaudeUsage = (data.usage ?? {}) as ClaudeUsage;
  return { ai: parseAi(text), usage };
}

/** Canned response for PARLEZ_MOCK mode — exercise the path without keys. */
function mockTurn(mode: TurnMode, personaName: string): { transcript: string } & AiResult {
  if (mode === 'open') {
    return {
      transcript: '',
      speechText: `Bonjour ! Je suis ${personaName}. Comment tu t’appelles ?`,
      translation: `Hello! I'm ${personaName}. What's your name?`,
      corrections: [],
      profileNotes: [],
      levelSignal: 'hold',
      learnerName: null,
      interests: [],
    };
  }
  return {
    transcript: 'Je vais bien, merci.',
    speechText: 'Super ! Qu’est-ce que tu as fait aujourd’hui ?',
    translation: 'Great! What did you do today?',
    corrections: [],
    profileNotes: [],
    levelSignal: 'hold',
    learnerName: null,
    interests: [],
  };
}

interface ConsolidateInput {
  notes: { note: string; count: number }[];
  summary: string;
}

interface ConsolidateOutput {
  canonical: { note: string; count: number }[];
}

/** Parse the canonical-list JSON Claude returns for a consolidation pass. */
function parseConsolidation(text: string): ConsolidateOutput {
  let parsed: Record<string, unknown> = {};
  try {
    const match = text.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : {};
  } catch {
    parsed = {};
  }
  const out: { note: string; count: number }[] = [];
  if (Array.isArray(parsed.canonical)) {
    for (const row of parsed.canonical as Array<Record<string, unknown>>) {
      if (!row || typeof row.note !== 'string') continue;
      const note = row.note.trim();
      if (!note) continue;
      const count =
        typeof row.count === 'number' && row.count > 0 ? Math.floor(row.count) : 1;
      out.push({ note, count });
      if (out.length >= 40) break;
    }
  }
  return { canonical: out };
}

/** Cheap Haiku call that merges near-duplicate notes into a canonical list. */
async function consolidate(input: ConsolidateInput): Promise<ConsolidateOutput> {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const model = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5';

  const payload = JSON.stringify({
    summary: input.summary,
    notes: input.notes.map((n) => ({ note: n.note, count: n.count })),
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system: [{ type: 'text', text: buildConsolidationPrompt() }],
      messages: [{ role: 'user', content: payload }],
    }),
  });
  if (!res.ok) throw new Error(`claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content ?? [])
    .filter((c: { type: string }) => c.type === 'text')
    .map((c: { text: string }) => c.text)
    .join('');
  return parseConsolidation(text);
}

/** Non-blocking usage write; failures must never fail the turn. */
function logUsage(row: Record<string, unknown>): void {
  try {
    const svc = serviceClient();
    void svc.from('usage_events').insert(row).then(({ error }) => {
      if (error) console.error('usage_events insert failed', error.message);
    });
  } catch (e) {
    console.error('serviceClient unavailable', e instanceof Error ? e.message : e);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  try {
    const contentType = req.headers.get('content-type') ?? '';

    // JSON body → either the consolidate mode, or a future text-only turn path.
    if (contentType.includes('application/json')) {
      const body = (await req.json()) as Record<string, unknown>;
      const mode = (body.mode as string) ?? '';
      if (mode === 'consolidate') {
        if (Deno.env.get('PARLEZ_MOCK') === 'true') {
          // In mock mode, just echo the incoming notes back as-is.
          const inputNotes = Array.isArray(body.notes)
            ? (body.notes as ConsolidateInput['notes'])
            : [];
          return json({ canonical: inputNotes.slice(0, 40) });
        }
        const out = await consolidate({
          notes: Array.isArray(body.notes)
            ? (body.notes as ConsolidateInput['notes'])
            : [],
          summary: typeof body.summary === 'string' ? body.summary : '',
        });
        return json(out);
      }
      return json({ error: `unsupported json mode: ${mode}` }, 400);
    }

    const form = await req.formData();
    const mode = ((form.get('mode') as string) ?? 'reply') as TurnMode;
    const simpler = form.get('simpler') === 'true';
    const ctx = normalizeContext(JSON.parse((form.get('context') as string) ?? '{}'));
    const text = (form.get('text') as string) || null;
    const audio = form.get('audio');
    const bodyAppUserId = (form.get('app_user_id') as string) || null;

    if (Deno.env.get('PARLEZ_MOCK') === 'true') {
      return json(mockTurn(mode, ctx.personaName));
    }

    // Resolve caller + enforce the daily cap before doing any paid work.
    const caller: Caller | null = resolveCaller(req, bodyAppUserId);
    if (caller) {
      try {
        const svc = serviceClient();
        const tier = await loadTier(svc, caller.userId, caller.isAnon);
        const cap = tierCapSeconds(tier);
        if (cap !== null) {
          const usedMs = await loadTodayElapsedMs(svc, caller.userId);
          if (usedMs >= cap * 1000) {
            return json(
              {
                reason: 'daily_cap',
                tier,
                cap_seconds: cap,
                used_seconds: Math.round(usedMs / 1000),
              },
              402,
            );
          }
        }
      } catch (e) {
        // Cap check must not block conversation on infra failure.
        console.error('cap check failed', e instanceof Error ? e.message : e);
      }
    }

    let transcript = text ?? '';
    let userSpeechMs = 0;

    if (mode === 'reply' && audio instanceof File) {
      // Whisper is the accurate path, but device audio can arrive empty or in an
      // unsupported container (notably Android's system recognizer, which doesn't
      // expose a usable recording). Fall back to the client's device transcript
      // instead of failing the whole turn; only rethrow if we have nothing.
      try {
        const whisper = await transcribe(audio, ctx);
        if (whisper.text) transcript = whisper.text;
        userSpeechMs = whisper.durationMs;
        if (caller) {
          logUsage({
            user_id: caller.userId,
            is_anon: caller.isAnon,
            kind: 'whisper',
            whisper_duration_ms: whisper.durationMs,
            whisper_bytes: whisper.bytes,
            estimated_cost_microcents: estimateWhisperMicrocents(whisper.durationMs).toString(),
          });
        }
      } catch (e) {
        if (!transcript) throw e;
      }
    }

    const { ai, usage } = await generate(ctx, mode, simpler, transcript);

    if (caller) {
      logUsage({
        user_id: caller.userId,
        is_anon: caller.isAnon,
        kind: 'claude',
        claude_input_tokens: usage.input_tokens ?? 0,
        claude_output_tokens: usage.output_tokens ?? 0,
        claude_cache_read_tokens: usage.cache_read_input_tokens ?? 0,
        claude_cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
        // elapsed_ms rides on the Claude row — one event per turn carries it, so
        // SUM(elapsed_ms) for the cap doesn't double-count. It's *conversation*
        // time (user speech + Marie's reply), not fn compute time, so the cap
        // binds on real practice minutes and can't be sidestepped by sideloaders.
        elapsed_ms: userSpeechMs + estimateSpeechMs(ai.speechText.length),
        estimated_cost_microcents: estimateClaudeMicrocents(usage).toString(),
      });
    }

    return json({ transcript, ...ai });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
