/**
 * Cost estimation for Phase 2 telemetry. Returns USD micro-cents
 * (1 microcent = 1e-6 USD = 1e-8 dollars) so SUMs stay integer-friendly.
 *
 * Rates verified current as of June 2026 — adjust here when provider pricing
 * changes. One source of truth for both edge fns and dashboards.
 *
 *   Claude Haiku 4.5: input  $1.00 / MTok, output $5.00 / MTok
 *                     cache write  $1.25 / MTok, cache read $0.10 / MTok
 *   ElevenLabs Flash v2.5: $0.10 per 1k chars (Creator tier; adjust if higher tier)
 *   ElevenLabs Scribe v1 (STT): $0.40 per hour of audio
 *   Whisper / gpt-4o-mini-transcribe: $0.006 per minute audio (fallback STT)
 */

const MICROCENTS_PER_USD = 100_000_000n;

function usdToMicrocents(usd: number): bigint {
  // Round-half-up via fixed-point.
  return BigInt(Math.round(usd * Number(MICROCENTS_PER_USD)));
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export function estimateClaudeMicrocents(u: ClaudeUsage): bigint {
  const inTok    = u.input_tokens             ?? 0;
  const outTok   = u.output_tokens            ?? 0;
  const cacheW   = u.cache_creation_input_tokens ?? 0;
  const cacheR   = u.cache_read_input_tokens     ?? 0;
  const usd =
    (inTok  * 1.00 / 1_000_000) +
    (outTok * 5.00 / 1_000_000) +
    (cacheW * 1.25 / 1_000_000) +
    (cacheR * 0.10 / 1_000_000);
  return usdToMicrocents(usd);
}

export function estimateTtsMicrocents(chars: number): bigint {
  const usd = (chars * 0.10) / 1_000;
  return usdToMicrocents(usd);
}

export function estimateWhisperMicrocents(durationMs: number): bigint {
  const minutes = durationMs / 60_000;
  const usd = minutes * 0.006;
  return usdToMicrocents(usd);
}

/**
 * ElevenLabs Scribe (primary STT) — $0.40 per hour of audio. The cost row still
 * uses the 'whisper' usage_kind + whisper_duration_ms column so no schema change
 * is needed; only the rate differs from the Whisper fallback.
 */
export function estimateScribeMicrocents(durationMs: number): bigint {
  const hours = durationMs / 3_600_000;
  const usd = hours * 0.40;
  return usdToMicrocents(usd);
}

/**
 * ElevenLabs Scribe v2 Realtime (streaming STT) — billed per hour of audio.
 * Defaults to the batch Scribe rate ($0.40/hr) until realtime pricing is
 * confirmed; override via SCRIBE_REALTIME_USD_PER_HOUR. Logged under the same
 * 'whisper' usage_kind / whisper_duration_ms column (no schema change).
 */
export function estimateScribeRealtimeMicrocents(durationMs: number): bigint {
  const perHour = Number(Deno.env.get('SCRIBE_REALTIME_USD_PER_HOUR') ?? '0.40');
  const rate = Number.isFinite(perHour) && perHour > 0 ? perHour : 0.40;
  const hours = durationMs / 3_600_000;
  return usdToMicrocents(hours * rate);
}
