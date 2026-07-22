-- 020_recommendation_batches.sql
--
-- Unified Recommendation Queue — lifecycle/slot table backing the single
-- member-facing queue (intro_requests). One row per (member, batch). This table
-- is the invariant anchor: two PARTIAL UNIQUE indexes make "at most one ACTIVE
-- batch and at most one QUEUED batch per member" a database guarantee, not merely
-- an application convention. It also carries the per-batch lifecycle metadata used
-- for analytics (queue timing, acceptance/completion rates).
--
-- NOT YET APPLIED. Operator applies this in the Supabase Dashboard AFTER approval
-- of the dry-run backfill report. Claude cannot see or mutate production state.

create table if not exists public.recommendation_batches (
  batch_id            uuid primary key default gen_random_uuid(),
  member_id           uuid not null references public.profiles(id) on delete cascade,
  -- Which producer created the batch. Members never see this — it is operational.
  batch_source        text not null check (batch_source in ('onboarding','weekly','admin_reciprocal','migration')),
  -- ACTIVE   → visible; its intro_requests rows are status 'suggested'
  -- QUEUED   → hidden, waiting; its intro_requests rows are status 'queued'
  -- COMPLETED→ fully resolved; kept for analytics
  -- DISCARDED→ organic queued batch displaced by an admin batch: its recommendation
  --            rows are DELETED, this metadata row is retained (no rec content)
  state               text not null check (state in ('active','queued','completed','discarded')),
  -- Links an admin-reciprocal materialization back to its introduction_batches id.
  reciprocal_batch_id uuid,
  created_at          timestamptz not null default now(),
  generated_at        timestamptz not null default now(),
  displayed_at        timestamptz,   -- set when the batch first becomes ACTIVE (visible)
  completed_at        timestamptz    -- set when the batch becomes fully resolved
);

-- THE active-window invariant, enforced by the database.
create unique index if not exists recommendation_batches_one_active_per_member
  on public.recommendation_batches (member_id) where state = 'active';
create unique index if not exists recommendation_batches_one_queued_per_member
  on public.recommendation_batches (member_id) where state = 'queued';

-- Supporting indexes for the queue service and admin metrics.
create index if not exists recommendation_batches_member_state_idx
  on public.recommendation_batches (member_id, state);
create index if not exists recommendation_batches_source_idx
  on public.recommendation_batches (batch_source);
create index if not exists recommendation_batches_reciprocal_idx
  on public.recommendation_batches (reciprocal_batch_id);

-- Members never read this table directly (they read intro_requests). The queue
-- service writes it with the service-role client, which bypasses RLS. Enabling RLS
-- with no member policy therefore denies all member access by default.
alter table public.recommendation_batches enable row level security;
