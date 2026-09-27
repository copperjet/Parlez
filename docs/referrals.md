# Referral & affiliate codes — ops guide

One code system, three lanes (`referral_codes.type`):

| Lane | Who | Referee gets | Owner gets | Owner sees |
|---|---|---|---|---|
| `user` | any user (auto-created on first open of the referral screen) | +10 min free taste (20 total) | +10 min bank when referee activates, +30 min when referee purchases; max 12 rewarded referrals / 365 days | Settings → Refer a friend |
| `creator` | influencer affiliates | same | cash: `commission_rate` (default 30%) of each referee's first payment, net of store fee + tax, paid manually after a 60-day holdback | Settings → Creator dashboard |
| `educator` | teachers referring **adult** students | same | free access granted manually via the RevenueCat dashboard (promotional entitlement) at your discretion, e.g. ≥3 active students | Settings → Educator dashboard (stats only) |

Bonus minutes live in the `bonus_grants` ledger (positive grants, negative
consumption). `turn` consumes them only when the caller is past their base
allowance (free taste) or daily cap (subscribers); `tts`/`stt-token` only check
the balance. Server is authoritative; the client mirrors allowance for routing.

Fraud posture: referee reward is instant (cheap); referrer rewards stage behind
activation (≥5 min real conversation) and a real store payment. One redemption
per identity ever. Per-code burst caps: user 10/day, educator 100/day, creator
500/day. All tunables (`DAILY_BURST_CAP`, `CREATOR_HOLDBACK_DAYS`,
`CREATOR_MIN_PAYOUT_USD`, reward sizes) live in
`supabase/functions/_shared/referral.ts`.

### What counts as a purchase (RevenueCat webhook)

A referral moves to `purchased` — and a creator commission is recorded — on the
referee's **first real payment**, which arrives as one of:

- `INITIAL_PURCHASE` with a non-trial period (bought straight away)
- `RENEWAL` with `is_trial_conversion = true` (the 7-day intro trial converting)
- `NON_RENEWING_PURCHASE` (Lifetime)

Renewals never re-credit. A store refund (`CANCELLATION` with
`cancel_reason = CUSTOMER_SUPPORT`) sets `referrals.refunded_at`; that
commission never becomes payable, and if already paid it's netted off the next
payout automatically.

## Designate a creator / educator

Partners **must have a signed-in Parlez account** — the dashboard is served only
to a verified session, and the code's `owner_id` must be their Supabase user id.
Ask them to sign in (Settings → Account), then in Supabase Studio → SQL editor:

```sql
-- Creator (30% default; set commission_rate for anchor deals, e.g. 0.400)
insert into referral_codes (code, owner_id, type, label)
select 'MARIEFR', id::text, 'creator', 'Marie French TikTok'
from auth.users where email = 'marie@example.com';

-- Educator (optionally cap a cohort)
insert into referral_codes (code, owner_id, type, label, max_redemptions)
select 'PROFDUPONT', id::text, 'educator', 'M. Dupont — Alliance Française Toronto', 50
from auth.users where email = 'dupont@example.com';
```

`insert 0 0` means no account exists for that email yet. Their Settings shows
the dashboard entry the next time they open Settings. One creator/educator code
per account (the dashboard uses the most recent active one).

Re-point an existing code to a partner's account:
`update referral_codes set owner_id = (select id::text from auth.users where email = 'marie@example.com') where code = 'MARIEFR';`

Codes are matched after normalization (uppercase, whitespace stripped, optional
`PZ-` prefix stripped) — store them uppercase, alphanumeric.

Deactivate: `update referral_codes set active = false where code = 'MARIEFR';`
(hides the dashboard entry too).

## Monthly creator payouts

Creators see their own numbers in the dashboard (pending / available / paid, plus
recent sales). The same math, for you — who is owed at least the minimum:

```sql
with owed as (
  select
    c.code,
    c.label,
    coalesce(sum(r.commission_usd) filter (
      where r.refunded_at is null
        and r.purchased_at <= now() - interval '60 days'), 0)
    - coalesce((select sum(p.amount_usd) from creator_payouts p where p.code = c.code), 0)
      as available_usd
  from referral_codes c
  left join referrals r on r.code = c.code and r.status = 'purchased'
  where c.type = 'creator'
  group by c.code, c.label
)
select * from owed where available_usd >= 25 order by available_usd desc;
```

After sending the money (PayPal/Wise), **record it** — this is what moves it from
"Available" to "Paid to date" on their dashboard:

```sql
insert into creator_payouts (code, amount_usd, method, reference)
values ('MARIEFR', 48.75, 'PayPal', 'PayPal txn 9XY123…');
```

`commission_usd` is null when RevenueCat didn't report a price (e.g. sandbox
events); those show as "—" and count as $0.

## Deploy

```
npx supabase db push
npx supabase functions deploy turn tts stt-token revenuecat-webhook delete-account referral
```

## Share link format

`https://play.google.com/store/apps/details?id=com.denny32.parlez&referrer=referral_code%3D<CODE>`

Android onboarding pre-fills the code from the Play Install Referrer
(`expo-application`). iOS has no install referrer — users type the code from
the share message during onboarding, or later in Settings → Refer a friend.
