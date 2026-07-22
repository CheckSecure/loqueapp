-- 021_intro_requests_queue.sql
--
-- Unified Recommendation Queue — make intro_requests the single member-facing
-- queue. Two changes:
--   1. batch_id: link each recommendation row to its recommendation_batches row.
--      (The unified 2-person batch model already writes batch_id from application
--      code; this guarantees the column exists — intro_requests was created
--      directly in Supabase with no migration file, so IF NOT EXISTS is safe.)
--   2. Allow the new 'queued' status (a hidden batch waiting behind the active one).
--
-- NOT YET APPLIED. Operator applies in the Supabase Dashboard after approval.

alter table public.intro_requests
  add column if not exists batch_id uuid;

create index if not exists intro_requests_requester_status_batch_idx
  on public.intro_requests (requester_id, status, batch_id);

-- Allow status = 'queued'. intro_requests.status accumulated its vocabulary over
-- time (suggested, pending, accepted, admin_pending, approved, passed, hidden,
-- hidden_permanent, archived, declined, rejected, accepted_pending_payment). If a
-- CHECK constraint restricts it, recreate that constraint to include 'queued';
-- if none exists (status is app-controlled), this is a no-op. DDL is transactional,
-- so if the ADD fails because production holds a status value not enumerated here,
-- the whole statement rolls back and the operator can add the missing value — no
-- half-applied constraint. Re-runnable.
do $$
begin
  if exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where t.relname = 'intro_requests'
      and n.nspname = 'public'
      and c.contype = 'c'
      and c.conname = 'intro_requests_status_check'
  ) then
    alter table public.intro_requests drop constraint intro_requests_status_check;
    alter table public.intro_requests add constraint intro_requests_status_check
      check (status in (
        'suggested','queued','pending','accepted','admin_pending','approved',
        'passed','hidden','hidden_permanent','archived','declined','rejected',
        'accepted_pending_payment'
      ));
    raise notice 'intro_requests_status_check recreated to include queued';
  else
    raise notice 'no intro_requests_status_check constraint found; status is app-controlled, queued already permitted';
  end if;
end $$;
