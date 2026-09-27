-- Referral & affiliate code system (growth: two-sided referral + creator/educator codes).
--
-- referral_codes : one shareable code per owner; type routes reward behaviour
--                  (user = friend referral, creator = influencer affiliate,
--                   educator = teacher referring adult students)
-- referrals      : one redemption per referee identity EVER (PK enforces);
--                  status ladder redeemed -> activated -> purchased doubles as
--                  the attribution funnel (conversion-per-code analytics)
-- bonus_grants   : bonus-minutes bank ledger. Positive rows are grants
--                  (referee redeem, referrer rewards), negative rows are
--                  consumption written by `turn` when a caller converses past
--                  their base allowance. Balance = SUM(ms).
--
-- All ids are RevenueCat app_user_id strings (== Supabase uuid after RC logIn),
-- matching `subscriptions.app_user_id` — anonymous users must be able to redeem
-- during onboarding, before any auth row exists.

create type code_type as enum ('user', 'creator', 'educator');
create type referral_status as enum ('redeemed', 'activated', 'purchased');

create table public.referral_codes (
  code            text primary key,                 -- normalized uppercase, no 0/O/1/I
  owner_id        text not null,                    -- app_user_id of the owner
  type            code_type not null default 'user',
  max_redemptions int,                              -- null = per-type default (see edge fn)
  active          boolean not null default true,
  label           text,                             -- creator/educator display name for payout reports
  created_at      timestamptz not null default now()
);

create index referral_codes_owner on public.referral_codes (owner_id);

create table public.referrals (
  referee_id   text primary key,                    -- one redemption per identity ever
  code         text not null references public.referral_codes (code),
  referrer_id  text not null,                       -- code owner at redemption time (denormalized)
  status       referral_status not null default 'redeemed',
  redeemed_at  timestamptz not null default now(),
  activated_at timestamptz,
  purchased_at timestamptz
);

create index referrals_referrer on public.referrals (referrer_id);
create index referrals_code on public.referrals (code);

create table public.bonus_grants (
  id             bigserial primary key,
  user_id        text not null,
  ms             bigint not null,                   -- positive grant, negative consumption
  reason         text not null,                     -- referee_redeem | referrer_activated | referrer_purchased | consumed
  ref_referee_id text,                              -- the referee that triggered a grant (idempotency key)
  created_at     timestamptz not null default now()
);

create index bonus_grants_user on public.bonus_grants (user_id);

-- A given (user, reason, referee) grant may exist only once — makes webhook
-- retries and duplicate activation events naturally idempotent. Consumption
-- rows repeat freely.
create unique index bonus_grants_idem on public.bonus_grants (user_id, reason, ref_referee_id)
  where reason <> 'consumed';

-- RLS — same posture as usage_events/subscriptions: signed-in users may read
-- their own rows; every write goes through the service-role client.
alter table public.referral_codes enable row level security;
alter table public.referrals      enable row level security;
alter table public.bonus_grants   enable row level security;

create policy referral_codes_select_own on public.referral_codes
  for select using (
    auth.uid() is not null and auth.uid()::text = owner_id
  );

create policy referrals_select_own on public.referrals
  for select using (
    auth.uid() is not null and auth.uid()::text = referrer_id
  );

create policy bonus_grants_select_own on public.bonus_grants
  for select using (
    auth.uid() is not null and auth.uid()::text = user_id
  );
