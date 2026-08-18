-- 062 — Durable resolution REASON for a dismissed recommendation, plus the one transactional
-- path for "I already know them" on a reciprocal pair.
--
-- WHY: the three dismiss choices on an introduction card were indistinguishable after the fact.
-- "Not for me", "Don't show again" and the new "I already know them" all collapsed into a status
-- ('passed' / 'hidden_permanent'), so we could never tell a rejected FIT from a member who simply
-- already has the relationship. This adds the reason as its own column, alongside — never instead
-- of — the existing status architecture.
--
-- ADDITIVE AND BACKWARD-COMPATIBLE BY CONSTRUCTION:
--   • the column is NULLABLE with no default, so all existing rows stay valid untouched and no
--     backfill is required or implied (a NULL reason means "dismissed before we recorded reasons",
--     which is exactly the truth and must never be guessed at retroactively);
--   • the CHECK admits NULL, so nothing that writes intro_requests today can start failing;
--   • no status value is added, renamed or removed — intro_requests_status_check is NOT touched,
--     and neither is member_pairs' status CHECK;
--   • application code that never selects or sets the column keeps working unchanged.
--
-- NOT A QUALITY SIGNAL: 'already_know' records an EXISTING RELATIONSHIP. Nothing may read it as a
-- negative score, a block, or evidence that either member is a poor match. It exists so the pair is
-- not re-introduced and so the funnel can be read honestly later.

-- ── 1) The reason column ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.intro_requests
  ADD COLUMN IF NOT EXISTS resolution_reason text NULL;

-- Enumerated allowlist. NULL is explicitly permitted (see above); anything else is rejected so a
-- typo'd reason can never enter the funnel data.
ALTER TABLE public.intro_requests
  DROP CONSTRAINT IF EXISTS intro_requests_resolution_reason_check;
ALTER TABLE public.intro_requests
  ADD CONSTRAINT intro_requests_resolution_reason_check
  CHECK (
    resolution_reason IS NULL
    OR resolution_reason IN ('not_for_me', 'never_show', 'already_know')
  );

-- Partial index: analytics reads only the rows that HAVE a reason, and the column is NULL for the
-- overwhelming majority of rows, so a partial index stays small.
CREATE INDEX IF NOT EXISTS intro_requests_resolution_reason_idx
  ON public.intro_requests (resolution_reason)
  WHERE resolution_reason IS NOT NULL;

COMMENT ON COLUMN public.intro_requests.resolution_reason IS
  'Why a recommendation was dismissed, as chosen by the member: not_for_me (declined the fit) | never_show (never show this person again) | already_know (an existing relationship — NOT a negative-quality signal). NULL = dismissed before reasons were recorded; never backfilled or inferred. Additive metadata only: exclusion is still decided by status.';

-- ── 2) Pair-aware "I already know them" (transactional, service-authorized) ──────────────────────
-- The sibling of pass_reciprocal_pair, and deliberately built to the same discipline: participant
-- advisory locks taken in canonical order (lo, hi) so concurrent calls sharing a member serialize
-- and can never deadlock, then a member_pairs row lock — so this is safe against a concurrent
-- pass / interest / match / rotation, and idempotent on retry.
--
-- WHY AN RPC AND NOT TWO CLIENT UPDATES: a pair spans two members. Closing one direction and then
-- the other from the application would leave a window where the pair is half-closed — one member's
-- card gone, the other's still live — and a crash between the two writes would strand it there
-- permanently. One transaction makes both directions close together or not at all.
--
-- WHAT IT CLOSES: both directional rows that are still PRESENTATIONAL ('suggested','queued',
-- 'expired','passed') become 'hidden_permanent' + 'already_know'. A row already carrying a
-- COMMITTED status (pending / accepted / accepted_pending_payment / admin_pending / approved /
-- declined / rejected) is deliberately LEFT ALONE: those represent a real, possibly credit-charged
-- action by that member, and silently erasing one to record a preference would destroy member
-- state. Exclusion is unaffected either way — every one of those statuses is already HARD history
-- (lib/introRequests/history.ts), so the pair stays permanently excluded in both directions
-- regardless of which branch a row takes.
--
-- PRECEDENCE: an existing match is terminal and is never destroyed here, exactly as in
-- pass_reciprocal_pair.
--
-- member_pairs.status is set to 'passed' — the existing terminal "this pair's presentation is
-- closed" value. No new pair status is introduced (that would mean editing member_pairs' CHECK);
-- the DISTINCT meaning lives on intro_requests.resolution_reason, which is the point of this
-- migration. 'blocked' is deliberately NOT used: this is not a block and must not read as one.
--
-- Returns 'already_known' | 'matched' | 'invalid'.
CREATE OR REPLACE FUNCTION public.mark_pair_known(
  p_pair_id uuid,
  p_actor_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  pair public.member_pairs%ROWTYPE;
BEGIN
  IF p_pair_id IS NULL OR p_actor_id IS NULL THEN RETURN 'invalid'; END IF;

  SELECT * INTO pair FROM public.member_pairs WHERE id = p_pair_id;
  -- AUTHORIZATION: the actor must be one of the two members of THIS pair. A caller cannot pass a
  -- pair they are not part of, so this can never alter an unrelated member's recommendations.
  IF NOT FOUND OR (p_actor_id <> pair.user_a_id AND p_actor_id <> pair.user_b_id) THEN
    RETURN 'invalid';
  END IF;

  -- Participant-safe locks in canonical order + pair-row lock (mirrors pass_reciprocal_pair).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pair.user_a_id::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pair.user_b_id::text, 0));
  SELECT * INTO pair FROM public.member_pairs WHERE id = p_pair_id FOR UPDATE;

  -- A formed match wins and is never undone by a late "already know them".
  IF EXISTS (
    SELECT 1 FROM public.matches m
    WHERE (m.user_a_id = pair.user_a_id AND m.user_b_id = pair.user_b_id)
       OR (m.user_a_id = pair.user_b_id AND m.user_b_id = pair.user_a_id)
  ) THEN
    UPDATE public.member_pairs SET status = 'matched' WHERE id = pair.id AND status <> 'matched';
    RETURN 'matched';
  END IF;

  -- BOTH directions, one statement, one transaction.
  UPDATE public.intro_requests
  SET status = 'hidden_permanent',
      resolution_reason = 'already_know',
      updated_at = now()
  WHERE pair_id = pair.id
    AND status IN ('suggested', 'queued', 'expired', 'passed');

  UPDATE public.member_pairs SET status = 'passed' WHERE id = pair.id AND status <> 'matched';

  RETURN 'already_known';
END;
$$;

-- Least-privilege: never callable by a browser role; only the server's service role, which always
-- derives the actor id from a verified session (never from client input).
REVOKE ALL ON FUNCTION public.mark_pair_known(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_pair_known(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.mark_pair_known(uuid, uuid) IS
  'Pair-aware "I already know them". Closes BOTH directional intro_requests rows of a pair to hidden_permanent + resolution_reason=already_know in one transaction, under the same participant advisory locks as pass_reciprocal_pair. Actor must be a participant. An existing match takes precedence and is never destroyed. Committed rows (pending/accepted/approved/...) are left intact and remain HARD-excluded. Records an existing relationship — NOT a block or a negative-quality signal.';
