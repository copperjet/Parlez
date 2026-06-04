-- Parlez cloud sync (spec §8.2, §11.2 P1).
-- One row per user holding the learning profile as a JSON blob. Row-level
-- security guarantees a user can only ever touch their own row.

create table if not exists public.user_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  state      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

create policy "Users read their own state"
  on public.user_state for select
  using (auth.uid() = user_id);

create policy "Users insert their own state"
  on public.user_state for insert
  with check (auth.uid() = user_id);

create policy "Users update their own state"
  on public.user_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users delete their own state"
  on public.user_state for delete
  using (auth.uid() = user_id);
