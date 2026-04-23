-- Prompt #15 — Supply Control & Ranking Discipline
-- Andrel | 2026-04-23
-- Schema additions for matcher run logging, event logging, viewed_at
-- on candidates, behavioral signal columns on profiles, tranche tracking,
-- and retry scheduling fields.

alter table public.opportunity_candidates
  add column if not exists tranche smallint not null default 1,
  add column if not exists viewed_at timestamptz;

create index if not exists opportunity_candidates_viewed_idx
  on public.opportunity_candidates(user_id, viewed_at)
  where viewed_at is null;

alter table public.opportunities
  add column if not exists tranche_2_scheduled_at timestamptz,
  add column if not exists last_matcher_run_at timestamptz,
  add column if not exists retry_count smallint not null default 0;

alter table public.profiles
  add column if not exists opp_delivered_count int not null default 0,
  add column if not exists opp_response_rate numeric(4,3),
  add column if not exists opp_conversation_continuation_rate numeric(4,3);

create table if not exists public.opportunity_matcher_runs (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  run_at timestamptz not null default now(),
  tranche smallint not null,
  delivery_mode text,
  delivered_count int not null default 0,
  total_scanned int,
  rate_limited_count int,
  below_threshold_count int,
  top_score int,
  reason text
);

create index if not exists opportunity_matcher_runs_opp_idx
  on public.opportunity_matcher_runs(opportunity_id, run_at desc);

create table if not exists public.opportunity_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  metadata jsonb
);

create index if not exists opportunity_events_type_idx
  on public.opportunity_events(event_type, created_at desc);

create index if not exists opportunity_events_opp_idx
  on public.opportunity_events(opportunity_id, event_type);

alter table public.opportunity_matcher_runs enable row level security;
alter table public.opportunity_events enable row level security;
