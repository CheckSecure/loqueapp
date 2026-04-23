-- Opportunities Engine — add archived_at for soft-delete
-- Andrel | 2026-04-23

alter table public.opportunities
  add column if not exists archived_at timestamptz;

create index if not exists opportunities_archived_at_idx
  on public.opportunities(archived_at)
  where archived_at is null;
