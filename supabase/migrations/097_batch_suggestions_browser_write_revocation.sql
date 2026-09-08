-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 097 — batch_suggestions: revoke the browser UPDATE surface (Andrel Next, Phase 3 Stage 1b)
--
-- Migration 055 revoked browser-role DML on the core member tables — profiles, messages, meetings,
-- credit_transactions, matches, conversations, intro_requests — because the browser ships the anon
-- key, so an authenticated member can call PostgREST directly as the `authenticated` role. It did
-- not cover public.batch_suggestions, which is the last core table still holding a browser write.
--
-- WHAT THAT SURFACE IS. The as-built record (docs/migrations/2026-05-11_batch_suggestions_rls_as_built.md)
-- documents exactly two live policies on this table:
--
--   batch_suggestions_recipient_self_read       SELECT  USING (recipient_id = auth.uid())
--   "Users can update their own batch suggestions"  UPDATE  USING/WITH CHECK (recipient_id = auth.uid())
--
-- The UPDATE policy is ownership-scoped, so this is not an open write — a member can only change
-- their OWN rows. But the column set is not scoped at all: from the console that member can set any
-- updatable column on any of their own suggestions, including `status`, `match_score`,
-- `materialized_at`, `dropped_at` and `shown_at`, which the admin review and approval flow reads to
-- decide what to materialize. Application code should own that transition, not the browser.
--
-- WHAT REPLACES IT. app/api/intro/hide-suggestion — the ONE legitimate browser-originated write —
-- now authorizes with getUser() and performs the UPDATE as service_role, scoped by BOTH the row id
-- and recipient_id = the caller's own id. Exactly the pattern 055 established for the other tables.
--
-- ── SMALLEST SAFE CHANGE ──────────────────────────────────────────────────────────────────────
-- UPDATE only. INSERT and DELETE privileges on this table are NOT touched in either direction —
-- not granted, not revoked — because they were not part of the authorized change; section 2 below
-- REPORTS their state rather than altering it. SELECT is untouched, and the recipient-self SELECT
-- policy is explicitly preserved and re-asserted after apply: revoking a member's ability to SEE
-- their own suggestions would break the Introductions page.
--
-- Idempotent · additive · re-runnable. Touches no data, no function, and no other table.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── SECTION 0 — PRECONDITIONS ────────────────────────────────────────────────────────────────
DO $precheck$
BEGIN
  IF pg_catalog.to_regclass('public.batch_suggestions') IS NULL THEN
    RAISE EXCEPTION '097 REFUSED: public.batch_suggestions does not exist.';
  END IF;

  -- The recipient-self SELECT policy is the thing this migration must NOT break. If it is already
  -- absent, the live contract is not what the as-built record describes and the operator must
  -- reconcile that before a privilege change, not after.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'batch_suggestions'
      AND policyname = 'batch_suggestions_recipient_self_read'
  ) THEN
    RAISE EXCEPTION
      '097 REFUSED: policy batch_suggestions_recipient_self_read is absent; live RLS does not match the as-built record.';
  END IF;
END
$precheck$;


-- ── SECTION 1 — REVOKE THE BROWSER UPDATE PRIVILEGE ──────────────────────────────────────────
-- The privilege is what actually decides. A policy can never grant a privilege the role does not
-- hold, so once this runs the UPDATE policy below is unreachable regardless of what it says.
REVOKE UPDATE ON TABLE public.batch_suggestions FROM PUBLIC, anon, authenticated;

-- Explicitly PRESERVE the server's ability to write. Idempotent and unaffected by the revoke above
-- (service_role is a distinct grantee), stated for the same reason 055 stated it: so the intended
-- posture is legible in one file rather than inferred from an absence.
GRANT SELECT, UPDATE ON TABLE public.batch_suggestions TO service_role;

-- Drop the now-unreachable permissive UPDATE policy. Same reasoning as migration 055: a policy that
-- can never fire is a dead, misleading grant, and leaving it invites a future reader to conclude
-- the browser may still write here. The SELECT policy is deliberately NOT touched.
DROP POLICY IF EXISTS "Users can update their own batch suggestions" ON public.batch_suggestions;


-- ── SECTION 2 — POSTAPPLY PROOF ──────────────────────────────────────────────────────────────
-- Assert the intended end state rather than trusting that the statements above ran. Any failure
-- rolls the whole migration back.
DO $postcheck$
DECLARE
  v_ins text;
  v_del text;
BEGIN
  -- (1) The browser can no longer UPDATE.
  IF pg_catalog.has_table_privilege('anon', 'public.batch_suggestions', 'UPDATE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.batch_suggestions', 'UPDATE') THEN
    RAISE EXCEPTION '097: a browser role still holds UPDATE on public.batch_suggestions.';
  END IF;

  -- (2) The permissive UPDATE policy is gone.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'batch_suggestions'
      AND policyname = 'Users can update their own batch suggestions'
  ) THEN
    RAISE EXCEPTION '097: the permissive browser UPDATE policy still exists.';
  END IF;

  -- (3) THE THING THAT MUST SURVIVE. The recipient-self SELECT policy and the browser's SELECT
  --     privilege both remain, or a member cannot see their own suggestions at all.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies
    WHERE schemaname = 'public' AND tablename = 'batch_suggestions'
      AND policyname = 'batch_suggestions_recipient_self_read'
      AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION '097: batch_suggestions_recipient_self_read was lost.';
  END IF;
  IF NOT pg_catalog.has_table_privilege('authenticated', 'public.batch_suggestions', 'SELECT') THEN
    RAISE EXCEPTION '097: authenticated lost SELECT on public.batch_suggestions.';
  END IF;

  -- (4) The server can still write.
  IF NOT pg_catalog.has_table_privilege('service_role', 'public.batch_suggestions', 'UPDATE') THEN
    RAISE EXCEPTION '097: service_role cannot UPDATE public.batch_suggestions.';
  END IF;

  -- (5) INSERT/DELETE are REPORTED, not changed. This migration was authorized to move UPDATE and
  --     nothing else, and INSERT rights in particular must not be broadened. Emitting the live
  --     state makes it a reviewable fact in the apply log instead of an assumption.
  v_ins := CASE WHEN pg_catalog.has_table_privilege('authenticated', 'public.batch_suggestions', 'INSERT')
                THEN 'HELD' ELSE 'absent' END;
  v_del := CASE WHEN pg_catalog.has_table_privilege('authenticated', 'public.batch_suggestions', 'DELETE')
                THEN 'HELD' ELSE 'absent' END;
  RAISE NOTICE '097: authenticated INSERT on batch_suggestions = %, DELETE = % (unchanged by this migration).',
    v_ins, v_del;
END
$postcheck$;

COMMIT;
