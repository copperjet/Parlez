-- Creator & educator dashboard: commission data + manual payout ledger.
--
-- A creator/educator is an account that owns an active referral_codes row with
-- type creator|educator and owner_id = its Supabase auth uid (designated by
-- SQL — see docs/referrals.md). The `referral` edge fn serves their dashboard
-- after verifying the caller's JWT.

-- Per-code commission rate so anchor creators can be on a richer deal (0.40).
alter table public.referral_codes
  add column commission_rate numeric(4, 3) not null default 0.300;

-- First-purchase economics, captured from the RevenueCat webhook when the
-- referral transitions to `purchased`. commission_usd is only set for creator
-- codes (the only lane paid in cash).
alter table public.referrals
  add column plan           text,
  add column gross_usd      numeric(10, 2),
  add column commission_usd numeric(10, 2),
  add column refunded_at    timestamptz;

-- Manual payout ledger — you record each payment you send (PayPal/Wise).
-- Available balance = eligible commissions (past holdback, not refunded) − Σ payouts.
create table public.creator_payouts (
  id         bigserial primary key,
  code       text not null references public.referral_codes (code),
  amount_usd numeric(10, 2) not null,
  paid_at    timestamptz not null default now(),
  method     text,
  reference  text
);

create index creator_payouts_code on public.creator_payouts (code);

-- Service-role only; the dashboard reads it through the edge function.
alter table public.creator_payouts enable row level security;
