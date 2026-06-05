-- Phase 2 monetization: usage telemetry + tiered cap + RevenueCat subscription mirror.
--
-- usage_events  : append-only fact table, one row per Claude / Whisper / TTS call
-- usage_daily   : SQL view, daily roll-up keyed by (user_id, day)
-- subscriptions : RevenueCat webhook mirror, upserted by `revenuecat-webhook` edge fn

create type usage_kind as enum ('claude', 'whisper', 'tts');

create table public.usage_events (
  id              bigserial primary key,
  user_id         uuid not null,                  -- supabase auth uid OR RC anon uuid
  is_anon         boolean not null default false, -- true => user_id is RC anon (no auth row)
  kind            usage_kind not null,
  occurred_at     timestamptz not null default now(),

  -- Claude
  claude_input_tokens        int,
  claude_output_tokens       int,
  claude_cache_read_tokens   int,
  claude_cache_write_tokens  int,

  -- Whisper
  whisper_duration_ms int,
  whisper_bytes       int,

  -- TTS
  tts_chars int,

  -- Conversation wall-clock attributed to this event (set once per turn, on the
  -- closing event, so SUM(elapsed_ms) doesn't double-count).
  elapsed_ms int,

  -- Cost estimate in USD micro-cents (1e-6 USD) for fast SUM aggregation.
  estimated_cost_microcents bigint
);

create index usage_events_user_day on public.usage_events
  (user_id, (occurred_at::date));

-- Daily roll-up. The `turn` edge function reads this to enforce the cap.
create view public.usage_daily as
select
  user_id,
  is_anon,
  (occurred_at at time zone 'utc')::date as day,
  sum(coalesce(claude_input_tokens, 0))       as claude_input_tokens,
  sum(coalesce(claude_output_tokens, 0))      as claude_output_tokens,
  sum(coalesce(claude_cache_read_tokens, 0))  as claude_cache_read_tokens,
  sum(coalesce(claude_cache_write_tokens, 0)) as claude_cache_write_tokens,
  sum(coalesce(whisper_duration_ms, 0))       as whisper_duration_ms,
  sum(coalesce(tts_chars, 0))                 as tts_chars,
  sum(coalesce(elapsed_ms, 0))                as elapsed_ms,
  sum(coalesce(estimated_cost_microcents, 0)) as estimated_cost_microcents
from public.usage_events
group by 1, 2, 3;

create type sub_tier   as enum ('monthly', 'annual', 'lifetime');
create type sub_status as enum ('active', 'trialing', 'in_grace', 'expired', 'cancelled');

create table public.subscriptions (
  app_user_id        text primary key,           -- RevenueCat appUserID (uuid string)
  supabase_user_id   uuid,                       -- null until sign-in / RC alias
  tier               sub_tier not null,
  status             sub_status not null,
  product_identifier text not null,
  period_type        text,                       -- TRIAL | NORMAL | INTRO
  current_period_end timestamptz,
  will_renew         boolean default true,
  last_event_type    text,
  last_event_at      timestamptz not null default now(),
  raw                jsonb
);

create index subscriptions_supabase_user on public.subscriptions (supabase_user_id);

-- RLS — signed-in user can read their own rows; service role bypasses for writes.
alter table public.usage_events  enable row level security;
alter table public.subscriptions enable row level security;

create policy usage_events_select_own on public.usage_events
  for select using (
    (not is_anon) and auth.uid() is not null and auth.uid()::text = user_id::text
  );

create policy subscriptions_select_own on public.subscriptions
  for select using (
    auth.uid() is not null and auth.uid() = supabase_user_id
  );
