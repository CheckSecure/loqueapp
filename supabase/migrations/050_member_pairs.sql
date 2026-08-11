-- 050 — Canonical reciprocal member pairs + one race-safe creation path for automatic
-- introductions. FOUNDATION ONLY: applying it changes NO behavior until code calls
-- public.create_reciprocal_suggestion(); existing intro_requests / recommendation_batches /
-- admin introductions / matches are untouched. Additive, idempotent, non-destructive.
--
-- PRIVACY / SECURITY: member_pairs is service-role ONLY (RLS enabled, NO policies). It stores only
-- participant IDs + coarse lifecycle metadata — never scores, notes, or sensitive profile data.
-- The RPC is SECURITY DEFINER with a hardened empty search_path and fully schema-qualified
-- references; EXECUTE is revoked from PUBLIC/anon/authenticated and granted only to service_role.

-- ── Canonical unordered pair anchor ─────────────────────────────────────────────
-- user_a_id < user_b_id is ENFORCED, so (A,B) and (B,A) are the SAME row and self-pairs are
-- impossible. UNIQUE(user_a_id,user_b_id) makes a pair creatable once → reversed/duplicate pairs
-- cannot exist. A pair PERSISTS permanently (audit record); it may be re-recommended after a
-- cooldown (last_recommended_at) — the RPC gates that, the row is not deleted or re-inserted.
CREATE TABLE IF NOT EXISTS public.member_pairs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_b_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source              text NOT NULL DEFAULT 'reciprocal'
                        CHECK (source IN ('reciprocal','onboarding','weekly','admin','backfill')),
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','expired','passed','matched','blocked','ineligible','superseded')),
  recommend_count     integer NOT NULL DEFAULT 0,
  first_recommended_at timestamptz,
  last_recommended_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_pairs_canonical_ck CHECK (user_a_id < user_b_id),  -- canonical + no self-pair
  CONSTRAINT member_pairs_unique       UNIQUE (user_a_id, user_b_id)   -- one pair ever (race-safe)
);

ALTER TABLE public.member_pairs ENABLE ROW LEVEL SECURITY; -- service-role only; NO policies
REVOKE ALL ON public.member_pairs FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.member_pairs IS
  'Canonical unordered auto-introduction pairs (user_a_id < user_b_id). Service-role only. One row per pair (UNIQUE) → reversed/duplicate impossible. Persists permanently; re-recommendable after cooldown via create_reciprocal_suggestion.';

-- ── Stable shared pair identifier on the two directional suggestion rows ─────────
-- Both directional intro_requests rows of a pair share this pair_id, while keeping their own
-- independent viewed/interest/pass status. Additive + nullable so existing rows are untouched.
ALTER TABLE public.intro_requests ADD COLUMN IF NOT EXISTS pair_id uuid REFERENCES public.member_pairs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS intro_requests_pair_id_idx ON public.intro_requests (pair_id);

-- ── The ONE reciprocal creation path (transactional, race-safe, eligibility- AND capacity-rechecked) ──
-- Creates a canonical pair + BOTH standard 'suggested' cards (is_admin_initiated=false, batch_id
-- NULL → pair-governed, not attached to either member's batch) so each member sees the other and
-- independently expresses interest/passes; mutual interest flows through the existing match path.
-- The "Introduced by Andrel" LABEL is rendered from the STRUCTURED pair_id, NOT from match_reason
-- (match_reason stays a genuine fit explanation or NULL). All eligibility/privacy/CAPACITY rules are
-- re-validated INSIDE the transaction under a row lock to defeat TOCTOU and never exceed a member's
-- visible-card limit. Returns 'created' | 'exists_active' | 'cooldown' | 'capacity' | 'ineligible' | 'invalid'.
CREATE OR REPLACE FUNCTION public.create_reciprocal_suggestion(
  a_id uuid,
  b_id uuid,
  p_source text DEFAULT 'reciprocal',
  p_reason text DEFAULT NULL,          -- genuine fit reason (or NULL); NOT the label
  p_cooldown_days integer DEFAULT 30,
  p_max_cards integer DEFAULT 2        -- RECOMMENDATIONS_PER_BATCH — per-member visible-card limit
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''            -- hardened: no mutable search_path; every ref is schema-qualified
AS $$
DECLARE
  lo uuid;
  hi uuid;
  pair public.member_pairs%ROWTYPE;
  eligible_count integer;
  a_cards integer;
  b_cards integer;
  cutoff timestamptz := now() - make_interval(days => GREATEST(p_cooldown_days, 0));
BEGIN
  IF a_id IS NULL OR b_id IS NULL OR a_id = b_id THEN
    RETURN 'invalid';
  END IF;
  lo := LEAST(a_id, b_id);
  hi := GREATEST(a_id, b_id);

  -- (0) PARTICIPANT-SAFE LOCKING. Take a transaction-scoped advisory lock on BOTH members, ALWAYS
  --     in canonical order (lo then hi) so concurrent calls sharing a member serialize and can never
  --     deadlock. This makes create(A,B) and create(C,B) mutually exclusive on B, so B's capacity is
  --     counted and consumed atomically (a pair-row lock alone did NOT serialize different pairs).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  -- (1) Both members currently eligible (canonical eligibility flags — mirrors lib/matching/eligibility.ts).
  SELECT count(*) INTO eligible_count
  FROM public.profiles p
  WHERE p.id IN (lo, hi)
    AND p.account_status = 'active'
    AND p.profile_complete = true
    AND coalesce(p.is_test_account, false) = false
    AND coalesce(p.is_admin, false) = false
    AND coalesce(p.matching_paused, false) = false
    AND p.email <> 'bizdev91@gmail.com';
  IF eligible_count <> 2 THEN
    RETURN 'ineligible';
  END IF;

  -- (2) Not blocked in either direction.
  IF EXISTS (
    SELECT 1 FROM public.blocked_users bu
    WHERE (bu.user_id = lo AND bu.blocked_user_id = hi)
       OR (bu.user_id = hi AND bu.blocked_user_id = lo)
  ) THEN
    RETURN 'ineligible';
  END IF;

  -- (3) Not already connected (matches is column-ordered → check both orders).
  IF EXISTS (
    SELECT 1 FROM public.matches m
    WHERE (m.user_a_id = lo AND m.user_b_id = hi)
       OR (m.user_a_id = hi AND m.user_b_id = lo)
  ) THEN
    RETURN 'ineligible';
  END IF;

  -- (4) No live/committed intro between them in EITHER direction (active window + expressed interest
  --     + permanent history), and no RECENT soft dismissal (passed/expired within cooldown). This
  --     also prevents a re-recommendation from surfacing a DUPLICATE active card next to an old row.
  IF EXISTS (
    SELECT 1 FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND (
        ir.status IN ('suggested','queued','pending','accepted','accepted_pending_payment',
                      'admin_pending','approved','declined','rejected','hidden','hidden_permanent')
        OR (ir.status IN ('passed','expired') AND ir.updated_at >= cutoff)
      )
  ) THEN
    RETURN 'exists_active';
  END IF;

  -- (5) CAPACITY (both sides): a pair consumes one visible-card slot for EACH member. Never exceed
  --     the per-member limit and never evict an existing card. If either side is full → skip.
  SELECT count(*) INTO a_cards FROM public.intro_requests ir
    WHERE ir.requester_id = a_id AND ir.status IN ('suggested','queued');
  SELECT count(*) INTO b_cards FROM public.intro_requests ir
    WHERE ir.requester_id = b_id AND ir.status IN ('suggested','queued');
  IF a_cards >= p_max_cards OR b_cards >= p_max_cards THEN
    RETURN 'capacity';
  END IF;

  -- (6) Claim / lock the canonical pair row (serializes concurrent creation of the SAME pair).
  INSERT INTO public.member_pairs (user_a_id, user_b_id, source)
  VALUES (lo, hi, p_source)
  ON CONFLICT (user_a_id, user_b_id) DO NOTHING;

  SELECT * INTO pair FROM public.member_pairs mp
  WHERE mp.user_a_id = lo AND mp.user_b_id = hi
  FOR UPDATE;

  -- (7) Cooldown on re-recommendation of an existing pair.
  IF pair.last_recommended_at IS NOT NULL AND pair.last_recommended_at >= cutoff THEN
    RETURN 'cooldown';
  END IF;

  -- (8) Create BOTH standard suggestion cards atomically (this transaction). batch_id stays NULL:
  --     these are pair-governed, so a member's weekly batch refresh cannot drop one side while the
  --     other survives. The label comes from pair_id; match_reason carries only a genuine fit reason.
  INSERT INTO public.intro_requests
    (requester_id, target_user_id, status, is_admin_initiated, match_reason, pair_id, created_at, updated_at)
  VALUES
    (a_id, b_id, 'suggested', false, p_reason, pair.id, now(), now()),
    (b_id, a_id, 'suggested', false, p_reason, pair.id, now(), now());

  UPDATE public.member_pairs
  SET recommend_count = recommend_count + 1,
      last_recommended_at = now(),
      first_recommended_at = coalesce(first_recommended_at, now()),
      status = 'active'
  WHERE id = pair.id;

  RETURN 'created';
END;
$$;

-- Least-privilege execution: never callable by end users; only the service role.
REVOKE ALL ON FUNCTION public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer) TO service_role;

-- ── Reciprocal ROTATION (weekly) ────────────────────────────────────────────────
-- WHY a dedicated path: a reciprocal card spans TWO members, so the existing per-member batch
-- lifecycle cannot govern it — expiring one member's batch would drop that side while the other
-- survives (a one-sided disappearance). Rotation is therefore PAIR-aware: it expires BOTH
-- directions of an UNTOUCHED, stale pair atomically, freeing capacity on both sides, and advances
-- member_pairs.status. A pair with ANY meaningful activity on EITHER side (interest, pass, accept,
-- admin, hidden, or a formed match) is NOT both-'suggested', so it is protected from rotation.
-- Returns the number of pairs expired.
CREATE OR REPLACE FUNCTION public.expire_stale_reciprocal_pairs(
  p_rotation_days integer DEFAULT 14,
  p_limit integer DEFAULT 500
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  expired_count integer := 0;
  rec record;
  suggested_cnt integer;
  cutoff timestamptz := now() - make_interval(days => GREATEST(p_rotation_days, 0));
BEGIN
  FOR rec IN
    SELECT mp.id, mp.user_a_id, mp.user_b_id
    FROM public.member_pairs mp
    WHERE mp.status = 'active'
      AND mp.last_recommended_at IS NOT NULL
      AND mp.last_recommended_at < cutoff
    ORDER BY mp.last_recommended_at ASC
    LIMIT GREATEST(p_limit, 0)
    FOR UPDATE SKIP LOCKED     -- other workers skip a locked pair; no double-processing, no deadlock
  LOOP
    SELECT count(*) INTO suggested_cnt
    FROM public.intro_requests ir WHERE ir.pair_id = rec.id AND ir.status = 'suggested';

    IF suggested_cnt = 2 THEN
      -- UNTOUCHED + stale → expire BOTH directions together (atomic) and release capacity.
      UPDATE public.intro_requests
      SET status = 'expired', updated_at = now()
      WHERE pair_id = rec.id AND status = 'suggested';
      UPDATE public.member_pairs SET status = 'expired' WHERE id = rec.id;
      expired_count := expired_count + 1;
    ELSIF EXISTS (
      SELECT 1 FROM public.matches m
      WHERE (m.user_a_id = rec.user_a_id AND m.user_b_id = rec.user_b_id)
         OR (m.user_a_id = rec.user_b_id AND m.user_b_id = rec.user_a_id)
    ) THEN
      -- Touched + connected → reconcile aggregate status so it is never left stale as 'active'.
      UPDATE public.member_pairs SET status = 'matched' WHERE id = rec.id;
    END IF;
    -- Otherwise (in-flight interest/pass) leave 'active'; the directional rows carry the truth and
    -- the pair is re-evaluated next run. Passed pairs stay protected + gated by the create cooldown.
  END LOOP;
  RETURN expired_count;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_reciprocal_pairs(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_reciprocal_pairs(integer, integer) TO service_role;

-- ── Pair-aware PASS (transactional, service-authorized) ─────────────────────────
-- A pass must terminally close the reciprocal presentation for BOTH sides without revealing who
-- passed. It: preserves the PASSER's directional row as 'passed' (audit + cooldown); neutrally
-- closes the COUNTERPART's still-'suggested' card to 'expired' (NOT 'passed', so the UI never
-- implies the counterpart passed) while preserving any meaningful counterpart state (e.g. pending
-- interest is left intact — never silently erased); sets member_pairs.status='passed'; and thereby
-- releases capacity on both sides. Participant-locked (canonical order) + a member_pairs row lock,
-- so it is concurrency-safe against pass/pass, pass/interest, pass/match, and pass/rotation, and
-- idempotent on retry. PRECEDENCE: an existing match wins and is never destroyed by a late pass.
-- Returns 'passed' | 'matched' | 'invalid'.
CREATE OR REPLACE FUNCTION public.pass_reciprocal_pair(
  p_pair_id uuid,
  p_passer_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  pair public.member_pairs%ROWTYPE;
  counterpart uuid;
BEGIN
  IF p_pair_id IS NULL OR p_passer_id IS NULL THEN RETURN 'invalid'; END IF;

  SELECT * INTO pair FROM public.member_pairs WHERE id = p_pair_id;
  IF NOT FOUND OR (p_passer_id <> pair.user_a_id AND p_passer_id <> pair.user_b_id) THEN
    RETURN 'invalid';
  END IF;

  -- Participant-safe locks (canonical order; schema-qualified) + pair-row lock → serializes vs
  -- create, other passes, and rotation (which locks the same member_pairs row).
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pair.user_a_id::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pair.user_b_id::text, 0));
  SELECT * INTO pair FROM public.member_pairs WHERE id = p_pair_id FOR UPDATE;

  counterpart := CASE WHEN p_passer_id = pair.user_a_id THEN pair.user_b_id ELSE pair.user_a_id END;

  -- PRECEDENCE: a formed match is terminal — a late pass never destroys it.
  IF EXISTS (
    SELECT 1 FROM public.matches m
    WHERE (m.user_a_id = pair.user_a_id AND m.user_b_id = pair.user_b_id)
       OR (m.user_a_id = pair.user_b_id AND m.user_b_id = pair.user_a_id)
  ) THEN
    UPDATE public.member_pairs SET status = 'matched' WHERE id = pair.id AND status <> 'matched';
    RETURN 'matched';
  END IF;

  -- Passer's audit row → 'passed' (idempotent; also upgrades an 'expired' row set by a concurrent
  -- counterpart-pass, so a simultaneous pass/pass records BOTH as passed).
  UPDATE public.intro_requests SET status = 'passed', updated_at = now()
  WHERE pair_id = pair.id AND requester_id = p_passer_id AND status IN ('suggested','expired');

  -- Counterpart's STILL-'suggested' card → neutral 'expired' (never 'passed'). A counterpart who
  -- already expressed interest ('pending') is NOT touched → their interest is preserved (it will
  -- time out via the existing pending-intro expiration), and later interest cannot resurrect a card
  -- that is already 'expired'.
  UPDATE public.intro_requests SET status = 'expired', updated_at = now()
  WHERE pair_id = pair.id AND requester_id = counterpart AND status = 'suggested';

  -- Terminal pair status (never override a match); capacity released for both (rows left 'suggested').
  UPDATE public.member_pairs SET status = 'passed' WHERE id = pair.id AND status <> 'matched';

  RETURN 'passed';
END;
$$;

REVOKE ALL ON FUNCTION public.pass_reciprocal_pair(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pass_reciprocal_pair(uuid, uuid) TO service_role;
