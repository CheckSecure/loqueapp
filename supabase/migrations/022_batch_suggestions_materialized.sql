-- 022_batch_suggestions_materialized.sql
--
-- Unified Recommendation Queue — batch_suggestions becomes an ADMIN-ONLY workspace.
-- When an admin approves ("sends") a reciprocal batch, its suggestions are now
-- MATERIALIZED into intro_requests (the single member-facing queue) instead of being
-- read directly by the member UI. materialized_at records that hand-off so the admin
-- workspace can show "sent → in member's queue" and analytics can measure it.
--
-- The existing status='shown' + shown_at handling is preserved (it drives the
-- 90-day re-suggestion cooldown in generate-batch); materialized_at is an ADDITIONAL
-- marker, orthogonal to status.
--
-- NOT YET APPLIED. Operator applies in the Supabase Dashboard after approval.

alter table public.batch_suggestions
  add column if not exists materialized_at timestamptz;

create index if not exists batch_suggestions_materialized_idx
  on public.batch_suggestions (batch_id, materialized_at);
