/**
 * `turn` Edge Function — the BFF for one conversational turn (spec §7.2).
 *
 * Receives the user's audio (or text) plus conversation context, runs Whisper
 * for STT, builds Marie's system prompt, calls Claude, and returns the
 * structured turn result. Voice audio is processed in memory and never stored
 * (spec §8).
 *
 * Set PARLEZ_MOCK=true to stub the providers for end-to-end testing without keys.
 */
import { corsHeaders, json } from '../_shared/cors.ts';
import {
  buildMessages,
  buildSystemPrompt,
  type PromptContext,
  type TurnMode,
} from '../_shared/prompt.ts';

interface AiResult {
  speechText: string;
  corrections: { original: string; corrected: string; gloss?: string }[];
  profileNotes: string[];
  levelSignal: 'up' | 'hold' | 'down';
}

function normalizeContext(raw: unknown): PromptContext {
  const c = (raw ?? {}) as Partial<PromptContext>;
  return {
    level: c.level === 'A' || c.level === 'C' ? c.level : 'B',
    profileSummary: typeof c.profileSummary === 'string' ? c.profileSummary : '',
    gapSinceLastSession:
      typeof c.gapSinceLastSession === 'number' ? c.gapSinceLastSession : null,
    history: Array.isArray(c.history) ? c.history : [],
  };
}

/** Whisper STT — French, with English code-switch tolerance (spec §6.1). */
async function transcribe(audio: File): Promise<string> {
  const key = Deno.env.get('OPENAI_API_KEY');
  if (!key) throw new Error('OPENAI_API_KEY not set');

  const fd = new FormData();
  // Keep the uploaded file's extension — Whisper uses it to detect the format.
  fd.append('file', audio, audio.name || 'turn.wav');
  fd.append('model', 'whisper-1');
  fd.append('language', 'fr');
  fd.append('response_format', 'json');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return typeof data.text === 'string' ? data.text.trim() : '';
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
  return {
    speechText: typeof parsed.speechText === 'string' ? parsed.speechText : '',
    corrections,
    profileNotes,
    levelSignal: sig === 'up' || sig === 'down' ? sig : 'hold',
  };
}

/** Claude generates Marie's structured response (spec §5, §7.5). */
async function generate(
  ctx: PromptContext,
  mode: TurnMode,
  simpler: boolean,
  transcript: string,
): Promise<AiResult> {
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const model = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5';

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
      // System prompt is static per turn — mark it cacheable so repeated input is
      // billed at the cache rate. No effect until the prompt exceeds the model's
      // cache minimum (1024 Sonnet / 2048 Haiku); harmless below it.
      system: [
        {
          type: 'text',
          text: buildSystemPrompt(ctx, mode, simpler),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: buildMessages(ctx, mode, transcript),
    }),
  });
  if (!res.ok) throw new Error(`claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content ?? [])
    .filter((c: { type: string }) => c.type === 'text')
    .map((c: { text: string }) => c.text)
    .join('');
  return parseAi(text);
}

/** Canned response for PARLEZ_MOCK mode — exercise the path without keys. */
function mockTurn(mode: TurnMode): { transcript: string } & AiResult {
  if (mode === 'open') {
    return {
      transcript: '',
      speechText: 'Bonjour ! Je suis Marie. Comment tu t’appelles ?',
      corrections: [],
      profileNotes: [],
      levelSignal: 'hold',
    };
  }
  return {
    transcript: 'Je vais bien, merci.',
    speechText: 'Super ! Qu’est-ce que tu as fait aujourd’hui ?',
    corrections: [],
    profileNotes: [],
    levelSignal: 'hold',
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  try {
    const form = await req.formData();
    const mode = ((form.get('mode') as string) ?? 'reply') as TurnMode;
    const simpler = form.get('simpler') === 'true';
    const ctx = normalizeContext(JSON.parse((form.get('context') as string) ?? '{}'));
    const text = (form.get('text') as string) || null;
    const audio = form.get('audio');

    if (Deno.env.get('PARLEZ_MOCK') === 'true') {
      return json(mockTurn(mode));
    }

    let transcript = text ?? '';
    if (mode === 'reply' && audio instanceof File) {
      transcript = await transcribe(audio);
    }

    const ai = await generate(ctx, mode, simpler, transcript);
    return json({ transcript, ...ai });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
