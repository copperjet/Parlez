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
import {
  loadEntitlement,
  loadLifetimeElapsedMs,
  loadTodayElapsedMs,
  tierCapSeconds,
} from '../_shared/caps.ts';
import {
  estimateClaudeMicrocents,
  estimateScribeMicrocents,
  estimateScribeRealtimeMicrocents,
  estimateWhisperMicrocents,
  type ClaudeUsage,
} from '../_shared/pricing.ts';

/**
 * Free-taste allowance (spec: value-first onboarding). A never-subscribed caller
 * may hold up to this much *lifetime* conversation time before the paywall — one
 * full first session (~10 min = the daily streak goal, so they light their first
 * flame on the way in). The server is authoritative; the client mirrors it only
 * for routing. Keep in sync with FREE_TASTE_SECONDS in the subscription store.
 */
const FREE_TASTE_MS = 10 * 60 * 1000;

interface AiResult {
  speechText: string;
  translation: string;
  segments: { label?: string; text: string }[];
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
        : 'Camille',
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
 * recently-used words (spec §6.1). The code-switch line keeps English words a
 * learner drops in from being force-respelled as French.
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
  return [
    `Conversation en français avec ${ctx.personaName}.`,
    `L'apprenant est anglophone et mélange parfois des mots ou phrases en anglais ; transcrire l'anglais tel quel, sans le franciser.`,
    learnerHint,
    recent,
  ]
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

/** Whisper STT — fallback when Scribe is unavailable (spec §6.1). */
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
  // No `language` pin — auto-detect so English (and French↔English code-switching)
  // is transcribed in its own language rather than force-decoded as French. The
  // context prompt below still biases toward this conversation's vocabulary.
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

/**
 * ElevenLabs Scribe STT — the primary recognizer (spec §6.1). Scribe is
 * code-switch native: with NO `language_code` it detects and transcribes each
 * word in its own language, so a learner can speak French, English, or a mix in
 * one sentence ("maintenant, je parle en français right now") and every word is
 * captured correctly. This is the balance Parlez needs to ramp users from
 * English toward French without the recognizer misunderstanding them.
 */
async function transcribeScribe(audio: File): Promise<WhisperResult> {
  const key = Deno.env.get('ELEVENLABS_API_KEY');
  if (!key) throw new Error('ELEVENLABS_API_KEY not set');

  const fd = new FormData();
  fd.append('file', audio, audio.name || 'turn.wav');
  fd.append('model_id', Deno.env.get('ELEVENLABS_STT_MODEL') ?? 'scribe_v1');
  // Intentionally omit `language_code` — that is what enables automatic language
  // detection and intra-sentence French↔English code-switching.
  fd.append('tag_audio_events', 'false');
  fd.append('diarize', 'false');

  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': key },
    body: fd,
  });
  if (!res.ok) throw new Error(`scribe ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  const bytes = audio.size ?? 0;
  // Scribe returns word-level timestamps (seconds); derive duration from the
  // last word's end, else fall back to the byte-rate estimate.
  const words = Array.isArray(data.words) ? (data.words as Array<{ end?: unknown }>) : [];
  const lastEnd = words.length > 0 ? Number(words[words.length - 1]?.end) : NaN;
  const durationMs =
    Number.isFinite(lastEnd) && lastEnd > 0
      ? Math.round(lastEnd * 1000)
      : estimateDurationMsFromBytes(bytes);
  return { text, durationMs, bytes };
}

/**
 * Pull a single JSON string field's value out of raw (possibly truncated) model
 * text. Used to salvage `speechText`/`translation` when the whole object won't
 * parse — see parseAi.
 */
function extractJsonString(text: string, key: string): string | null {
  const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string; // unescape \n, \" etc.
  } catch {
    return m[1];
  }
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
  // Salvage: a long explanation turn restates content in `segments`, which can
  // push the completion past max_tokens. The truncated text then fails to parse
  // → empty speechText → a silent/empty bubble. `speechText` is the FIRST field
  // in the schema, so it's almost always intact even when truncation cuts off
  // later fields — recover it (and translation) directly so the turn still talks.
  if (typeof parsed.speechText !== 'string' || !parsed.speechText.trim()) {
    const sp = extractJsonString(text, 'speechText');
    if (sp) {
      parsed.speechText = sp;
      if (typeof parsed.translation !== 'string' || !parsed.translation.trim()) {
        const tr = extractJsonString(text, 'translation');
        if (tr) parsed.translation = tr;
      }
    }
  }
  // Last-ditch salvage: the model ignored the JSON format entirely and answered
  // in plain prose — no parseable object, no "speechText" field to extract. Use
  // that prose as what Camille says rather than emitting an empty turn (→ false
  // technical-glitch apology). Guarded so a broken/partial JSON body (which the
  // branches above own) is never dumped to the user as raw text.
  if (typeof parsed.speechText !== 'string' || !parsed.speechText.trim()) {
    const stripped = text.replace(/```[a-z]*\n?|```/gi, '').trim();
    if (stripped && !stripped.startsWith('{') && !stripped.includes('"speechText"')) {
      parsed.speechText = stripped.slice(0, 600);
    }
  }
  const segments = Array.isArray(parsed.segments)
    ? (parsed.segments as unknown[])
        .map((s) => {
          const seg = (s ?? {}) as Record<string, unknown>;
          const text = typeof seg.text === 'string' ? seg.text.trim() : '';
          if (!text) return null;
          const label =
            typeof seg.label === 'string' && seg.label.trim()
              ? seg.label.trim()
              : undefined;
          return label ? { label, text } : { text };
        })
        .filter((s): s is { label?: string; text: string } => s != null)
        .slice(0, 6)
    : [];
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
    segments,
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

/** Sum two Claude usage records so a retried turn bills both API calls. */
function mergeUsage(a: ClaudeUsage, b: ClaudeUsage): ClaudeUsage {
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_read_input_tokens:
      (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
  };
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
      // Headroom for explanation turns: `segments` restates the speechText
      // content, so a long teaching reply roughly doubles the JSON. 800 then 1200
      // still occasionally truncated mid-object (parseAi → empty speechText →
      // silent turn); 1500 gives more room, and parseAi now salvages speechText
      // from a truncated body as a backstop. Billed on actual output, so the
      // higher ceiling only costs more when a reply genuinely needs it.
      max_tokens: 1500,
      // Default sampling temperature is 1.0, which makes Haiku occasionally emit
      // malformed or empty JSON even for an input it understood — surfacing to the
      // user as the false "petit problème technique" apology. The reply is a
      // structured object, not creative prose, so a lower temperature sharply cuts
      // format slips while keeping Camille's tone natural.
      temperature: 0.5,
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
      segments: [],
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
    segments: [],
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
    // Streaming STT (Tier 2): the client transcribed live and sends the final
    // text plus the measured speech duration so the cap still counts the user's
    // speech time on this no-audio path.
    const sttMsRaw = Number(form.get('stt_ms'));
    const streamedSttMs =
      Number.isFinite(sttMsRaw) && sttMsRaw > 0 ? Math.round(sttMsRaw) : 0;

    if (Deno.env.get('PARLEZ_MOCK') === 'true') {
      return json(mockTurn(mode, ctx.personaName));
    }

    // Resolve caller + enforce entitlement and the daily cap before any paid
    // work. An unidentified caller (no JWT, no app_user_id) is denied outright —
    // every legitimate client sends its RevenueCat appUserID.
    const caller: Caller | null = resolveCaller(req, bodyAppUserId);
    if (!caller) {
      return json({ reason: 'not_entitled' }, 403);
    }
    try {
      const svc = serviceClient();
      const { tier, entitled } = await loadEntitlement(svc, caller.userId);
      if (!entitled) {
        // Value-first: a non-entitled caller gets the free taste until their
        // LIFETIME conversation time crosses FREE_TASTE_MS, then the paywall (403).
        // Lifetime (not daily) so the allowance is genuinely one-time and a
        // churned subscriber — already well past it — is never re-granted free time.
        const freeUsedMs = await loadLifetimeElapsedMs(svc, caller.userId);
        if (freeUsedMs >= FREE_TASTE_MS) {
          return json({ reason: 'not_entitled' }, 403);
        }
        // Under the allowance — serve this turn for free (no tier cap applies).
      } else {
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
      }
    } catch (e) {
      // A genuine infra failure (DB/RC unreachable) must not block paying users;
      // fail open. A clean "not entitled" already returned 403 above.
      console.error('entitlement/cap check failed', e instanceof Error ? e.message : e);
    }

    let transcript = text ?? '';
    let userSpeechMs = 0;

    if (mode === 'reply' && audio instanceof File) {
      // Scribe is the accurate, code-switch-native path, but device audio can
      // arrive empty or in an unsupported container (notably Android's system
      // recognizer, which doesn't expose a usable recording). On any STT failure
      // we fall back to the client's device transcript; if that's also empty we
      // surface a clean STT-miss below — never a 500.
      try {
        const provider = Deno.env.get('PARLEZ_STT_PROVIDER') ?? 'elevenlabs';
        let stt: WhisperResult;
        let costMicrocents: bigint;
        if (provider === 'openai') {
          stt = await transcribe(audio, ctx);
          costMicrocents = estimateWhisperMicrocents(stt.durationMs);
        } else {
          // Primary: ElevenLabs Scribe. Fall back to Whisper on any Scribe hiccup
          // so a single provider failure never drops the turn.
          try {
            stt = await transcribeScribe(audio);
            costMicrocents = estimateScribeMicrocents(stt.durationMs);
          } catch (e) {
            console.error(
              'scribe failed, falling back to whisper',
              e instanceof Error ? e.message : e,
            );
            stt = await transcribe(audio, ctx);
            costMicrocents = estimateWhisperMicrocents(stt.durationMs);
          }
        }
        if (stt.text) transcript = stt.text;
        userSpeechMs = stt.durationMs;
        if (caller) {
          logUsage({
            user_id: caller.userId,
            is_anon: caller.isAnon,
            // STT cost rows keep the 'whisper' usage_kind + whisper_* columns
            // regardless of provider, so no schema migration is needed.
            kind: 'whisper',
            whisper_duration_ms: stt.durationMs,
            whisper_bytes: stt.bytes,
            estimated_cost_microcents: costMicrocents.toString(),
          });
        }
      } catch (e) {
        // Log and drop through — the empty-transcript guard handles the reply.
        console.error('stt failed', e instanceof Error ? e.message : e);
      }
    } else if (mode === 'reply' && streamedSttMs > 0) {
      // Streaming STT path: the transcript already arrived as `text`; no server
      // STT ran. Attribute the user's speech time to the cap and log the realtime
      // STT cost (reusing the 'whisper' usage_kind / whisper_* columns).
      userSpeechMs = streamedSttMs;
      if (caller) {
        logUsage({
          user_id: caller.userId,
          is_anon: caller.isAnon,
          kind: 'whisper',
          whisper_duration_ms: streamedSttMs,
          whisper_bytes: 0,
          estimated_cost_microcents: estimateScribeRealtimeMicrocents(streamedSttMs).toString(),
        });
      }
    }

    // Nothing transcribed (unusable audio + no device text) — return a 200 STT-miss
    // the client renders as a gentle re-prompt, rather than letting Camille answer
    // silence or leaking a 500 the UI shows as "couldn't respond".
    if (mode === 'reply' && !transcript.trim()) {
      return json({
        transcript: '',
        speechText: '',
        translation: '',
        corrections: [],
        profileNotes: [],
        levelSignal: 'hold',
        learnerName: null,
        interests: [],
      });
    }

    let { ai, usage } = await generate(ctx, mode, simpler, transcript);
    // Empty-reply guard: despite the lower temperature and the parseAi salvage,
    // Haiku can still return an empty speechText for a turn it understood. Rather
    // than ship that (→ the client's false "petit problème technique" apology),
    // retry once here — same region, no extra client round-trip. Bill both calls.
    if (!ai.speechText.trim()) {
      const retry = await generate(ctx, mode, simpler, transcript);
      usage = mergeUsage(usage, retry.usage);
      if (retry.ai.speechText.trim()) ai = retry.ai;
    }

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
