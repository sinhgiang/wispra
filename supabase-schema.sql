-- Wispra Phase 3 — Supabase schema
-- Run this in the Supabase SQL Editor (supabase.com → project → SQL Editor)

-- ── Tables ──────────────────────────────────────────────────────────────────

create table public.subscriptions (
  id                    uuid default gen_random_uuid() primary key,
  user_id               uuid references auth.users(id) on delete cascade unique not null,
  plan                  text not null default 'free',  -- 'free' | 'pro'
  polar_subscription_id text,
  polar_customer_id     text,
  current_period_end    timestamptz,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

create table public.usage (
  id           uuid default gen_random_uuid() primary key,
  user_id      uuid references auth.users(id) on delete cascade not null,
  month        text not null,          -- format: '2026-06'
  seconds_used integer default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique(user_id, month)
);

-- ── Row Level Security ───────────────────────────────────────────────────────

alter table public.subscriptions enable row level security;
alter table public.usage enable row level security;

create policy "Users can view own subscription" on public.subscriptions
  for select using (auth.uid() = user_id);

create policy "Users can view own usage" on public.usage
  for select using (auth.uid() = user_id);

-- ── Auto-create subscription on signup ──────────────────────────────────────

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.subscriptions (user_id) values (new.id);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Usage increment (upsert) ─────────────────────────────────────────────────

create or replace function public.increment_usage(
  p_user_id uuid,
  p_month   text,
  p_seconds integer
) returns void as $$
begin
  insert into public.usage (user_id, month, seconds_used)
  values (p_user_id, p_month, p_seconds)
  on conflict (user_id, month)
  do update set
    seconds_used = usage.seconds_used + p_seconds,
    updated_at   = now();
end;
$$ language plpgsql security definer;
