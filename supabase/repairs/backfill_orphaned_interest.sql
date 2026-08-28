-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- BACKFILL — close non-pair 'approved' rows whose counterpart can no longer answer.
--
-- Same predicate and same guards as the ORPHANED ONE-SIDED INTEREST stage in
-- lib/introductions/expiryWorker.ts. Running the deployed cron would eventually do this by
-- itself; this exists so the 34 already-stuck rows clear on YOUR schedule, with the set
-- inspected before anything moves.
--
-- SECTION A is read-only and shows exactly what would change. SECTION B is gated:
-- it does nothing until v_apply is edited to true.
--
-- THIS BACKFILL IS SILENT, BY DECISION. It writes intro_requests directly and never reaches the
-- expiryWorker code path, so it fires NO 'interest_expired' notification. Firing one per row for
-- cards up to six weeks old would be a worse first impression of the feature than the silence it
-- replaces. Notifications are for cards that expire from here forward. Do not "fix" this into
-- notifying without reopening the decision.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── A. DRY RUN — the exact rows, and why each qualifies ──────────────────────────────────
WITH cand AS (
  SELECT ir.id, ir.requester_id, ir.target_user_id, ir.updated_at,
    (SELECT c.status FROM public.intro_requests c
      WHERE c.requester_id = ir.target_user_id AND c.target_user_id = ir.requester_id
      ORDER BY c.updated_at DESC LIMIT 1)                                    AS counterpart_status,
    EXISTS (SELECT 1 FROM public.matches m
             WHERE (m.user_a_id = ir.requester_id AND m.user_b_id = ir.target_user_id)
                OR (m.user_b_id = ir.requester_id AND m.user_a_id = ir.target_user_id)) AS has_match
  FROM public.intro_requests ir
  WHERE ir.status = 'approved'
    AND ir.is_admin_initiated = false
    AND ir.pair_id IS NULL
    AND ir.updated_at < now() - interval '14 days'
)
SELECT pe.full_name AS expresser, pc.full_name AS counterpart,
       coalesce(c.counterpart_status, '(no row — never accepted)') AS counterpart_status,
       date_trunc('day', c.updated_at)                             AS approved_on,
       CASE
         WHEN c.has_match                                                    THEN 'SKIP — matched'
         WHEN c.counterpart_status IN ('approved','accepted','pending')      THEN 'SKIP — mutual, finalization owns it'
         WHEN c.counterpart_status = 'suggested'                             THEN 'SKIP — counterpart can still answer'
         ELSE 'CLOSE — counterpart cannot answer'
       END AS action
FROM cand c
JOIN public.profiles pe ON pe.id = c.requester_id
JOIN public.profiles pc ON pc.id = c.target_user_id
ORDER BY action, approved_on;

-- ── B. APPLY — edit v_apply to true, deliberately. ───────────────────────────────────────
DO $$
DECLARE
  v_apply constant boolean := false;   -- <<< set to true to write
  v_n integer;
BEGIN
  IF NOT v_apply THEN
    RAISE NOTICE 'DRY RUN: v_apply is false. Nothing was written.';
    RETURN;
  END IF;
  WITH cand AS (
    SELECT ir.id
    FROM public.intro_requests ir
    WHERE ir.status = 'approved'
      AND ir.is_admin_initiated = false
      AND ir.pair_id IS NULL
      AND ir.updated_at < now() - interval '14 days'
      AND NOT EXISTS (SELECT 1 FROM public.matches m
                       WHERE (m.user_a_id = ir.requester_id AND m.user_b_id = ir.target_user_id)
                          OR (m.user_b_id = ir.requester_id AND m.user_a_id = ir.target_user_id))
      AND NOT EXISTS (SELECT 1 FROM public.intro_requests c
                       WHERE c.requester_id = ir.target_user_id
                         AND c.target_user_id = ir.requester_id
                         AND c.status IN ('approved','accepted','pending','suggested'))
  )
  UPDATE public.intro_requests t
     SET status = 'expired', expired_at = now(), updated_at = now()
    FROM cand
   WHERE t.id = cand.id AND t.status = 'approved';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'APPLIED: % orphaned one-sided interest row(s) closed.', v_n;
END $$;
