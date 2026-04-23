-- Opportunities Engine — seen_by_creator_at for NEW response highlighting
-- Andrel | 2026-04-23

alter table public.opportunity_responses
  add column if not exists seen_by_creator_at timestamptz;

create index if not exists opportunity_responses_unseen_idx
  on public.opportunity_responses(opportunity_id, seen_by_creator_at)
  where seen_by_creator_at is null;
