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

-- Allow status = 'queued'. The enumerated list below is the COMPLETE set of
-- statuses the application writes to intro_requests (verified by source audit):
--   suggested, queued (new), pending, accepted, admin_pending, approved, passed,
--   hidden, hidden_permanent, archived, declined, rejected, expired,
--   accepted_pending_payment.
-- ('expired' is written by the expire-pending-intros and cleanup-expired-requests
-- crons; 'hidden' is a legacy read value kept for safety.) If a CHECK constraint
-- restricts status, recreate it to include 'queued'; if none exists (status is
-- app-controlled), this is a no-op. DDL is transactional, so if the ADD ever fails
-- because production holds a status not enumerated here, the whole statement rolls
-- back — no half-applied constraint. Re-runnable.
--
-- OPERATOR PRE-CHECK (run first, capture the result): the existing definition, if
-- any, so we can confirm this list is a superset before recreating:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.intro_requests'::regclass and contype = 'c';
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
        'expired','accepted_pending_payment'
      ));
    raise notice 'intro_requests_status_check recreated to include queued + expired';
  else
    raise notice 'no intro_requests_status_check constraint found; status is app-controlled, queued already permitted';
  end if;
end $$;
