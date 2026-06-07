-- The cap query (loadTodayElapsedMs) filters `usage_daily` by the UTC day, and
-- the view groups on `(occurred_at at time zone 'utc')::date`. The existing
-- index in 0002 uses `occurred_at::date` (session timezone), so it can't serve
-- the UTC-day grouping. Add a matching expression index so the per-user daily
-- roll-up stays index-served as usage_events grows.

create index if not exists usage_events_user_utcday
  on public.usage_events (user_id, ((occurred_at at time zone 'utc')::date));
