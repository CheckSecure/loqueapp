-- 093 — the DEFICIT MODEL for reciprocal placement.
--
-- RULE: a member receives new cards up to two minus however many they currently hold. Act on one,
-- get one. Act on both, get two.
--
-- ONLY ONE PATH CHANGES, and that was the whole problem. The admin batch has always been the
-- deficit model — app/api/admin/generate-batch builds capacityByMember from
-- visible_deficit(member) = max(0, MAX_VISIBLE - visible_count) and its own comment says "Nothing
-- else". create_reciprocal_suggestion additionally applied a BINARY response-eligibility gate
-- (migration 081 step 5b): if count_unresolved_introductions > 0 it returned 'unresolved' and
-- placed nothing. So a member holding one card was owed one more by the batch and zero by the
-- reciprocal path — coverage and the batch disagreeing about who was eligible, which is exactly the
-- split the gate was meant to prevent.
--
-- THIS DOES NOT RAISE ANYONE'S CEILING. Step (5) of the same function already returns 'capacity'
-- when a_cards >= max_cards OR b_cards >= max_cards, and max_cards is clamped to c_max_visible = 2.
-- 093 removes a second, stricter rule layered on top of that; the cap itself is untouched.
--
-- count_unresolved_introductions is NOT dropped. The Wednesday reminder and the post-batch referral
-- nudge both still call it to answer a different question — "does this member owe anyone a
-- response" — which remains meaningful even though it no longer gates placement.
--
-- THE 081 DRIFT GUARD NOW POINTS THE WRONG WAY. 081 refuses to apply if
-- create_reciprocal_suggestion already references count_unresolved_introductions. After 093 it does
-- not, so 081 would consider itself unapplied and re-add the gate. 093 therefore installs its own
-- marker comment inside the function body, and the verification block below fails loudly if a later
-- re-run of 081 ever removes it.

BEGIN;

DO $precheck$
BEGIN
  IF to_regclass('public.intro_requests') IS NULL THEN
    RAISE EXCEPTION '093 REFUSED: public.intro_requests does not exist.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'create_reciprocal_suggestion') THEN
    RAISE EXCEPTION '093 REFUSED: create_reciprocal_suggestion does not exist. Apply 081 first.';
  END IF;
END
$precheck$;

CREATE OR REPLACE FUNCTION public.create_reciprocal_suggestion(
  a_id uuid,
  b_id uuid,
  p_source text DEFAULT 'reciprocal',
  p_reason text DEFAULT NULL,          -- genuine fit reason (or NULL); NOT the label
  p_cooldown_days integer DEFAULT 30,
  p_max_cards integer DEFAULT 2,       -- >=1 is clamped to c_max_visible; NULL/<=0 -> 'invalid'
  p_release_id uuid DEFAULT NULL       -- the RELEASE ENVELOPE this placement belongs to (081)
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''            -- hardened: no mutable search_path; every ref is schema-qualified
AS $$
DECLARE
  c_max_visible constant integer := 2;   -- THE visible cap. Fixed here; no argument can raise it.
  lo uuid;
  hi uuid;
  pair public.member_pairs%ROWTYPE;
  eligible_count integer;
  a_cards integer;
  b_cards integer;
  max_cards integer;
  cutoff timestamptz := now() - make_interval(days => GREATEST(p_cooldown_days, 0));
BEGIN
  IF a_id IS NULL OR b_id IS NULL OR a_id = b_id THEN
    RETURN 'invalid';
  END IF;

  -- CAPACITY AUTHORITY IS THE DATABASE'S, AND A NONSENSE INPUT FAILS CLOSED.
  --
  --   >= 1        -> LEAST(value, c_max_visible). A caller may ask for FEWER cards than the cap (a
  --                  conservative producer); it can never ask for more, so p_max_cards = 100
  --                  behaves exactly as 2.
  --   NULL / <= 0 -> 'invalid', returned BEFORE any lock is taken and before any write.
  --
  -- The earlier draft coalesced NULL/0/negative up to the full cap of 2. That is the wrong
  -- direction: it turned a caller that had lost track of its own limit into a caller asking for the
  -- maximum. The TypeScript client no longer supplies this argument at all, so any NULL or
  -- non-positive value now reaching this function is a legacy or malformed call, and refusing it is
  -- both safe and informative. No legitimate caller passes one — verified repo-wide.
  IF p_max_cards IS NULL OR p_max_cards < 1 THEN
    RETURN 'invalid';
  END IF;
  max_cards := LEAST(p_max_cards, c_max_visible);

  lo := LEAST(a_id, b_id);
  hi := GREATEST(a_id, b_id);

  -- (0) PARTICIPANT-SAFE LOCKING. Transaction-scoped advisory lock on BOTH members, ALWAYS in
  --     canonical order (lo then hi) so concurrent calls sharing a member serialize and can never
  --     deadlock. Every count below happens only after both locks are held.
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

  -- (5) CAPACITY (both sides) — VISIBLE TIER ONLY. CHANGED FROM MIGRATION 050, which counted
  --     status IN ('suggested','queued') and so treated a reservation nobody has seen as if it were
  --     already on the member's screen. That was wrong in both directions: it refused an
  --     introduction to a member whose screen was empty but who held two queued rows, while never
  --     bounding how many 'suggested' rows could actually accumulate. A pair consumes one VISIBLE
  --     slot for EACH member. If either side is full → skip. Nothing is ever evicted.
  SELECT count(*) INTO a_cards FROM public.intro_requests ir
    WHERE ir.requester_id = a_id AND ir.status = 'suggested'
      AND ir.capacity_released_at IS NULL;
  SELECT count(*) INTO b_cards FROM public.intro_requests ir
    WHERE ir.requester_id = b_id AND ir.status = 'suggested'
      AND ir.capacity_released_at IS NULL;
  IF a_cards >= max_cards OR b_cards >= max_cards THEN
    RETURN 'capacity';
  END IF;

  -- (5b) RESPONSE ELIGIBILITY — REMOVED IN 093, replaced by the deficit already enforced above.
  --
  --      The removed statements counted a member's unanswered cards and refused outright when the
  --      count exceeded zero: a BINARY gate, where one unanswered card blocked a reciprocal
  --      placement entirely.
  --
  --      The admin batch never had that rule. app/api/admin/generate-batch computes
  --      visible_deficit = max(0, MAX_VISIBLE - visible_count) "and nothing else", so the two paths
  --      disagreed about who was eligible: a member holding one card was owed one more by the batch
  --      and zero by this function — precisely the coverage/batch split the rule meant to avoid.
  --
  --      CAPACITY IS UNCHANGED. Step (5) immediately above already returns 'capacity' when
  --      a_cards >= max_cards or b_cards >= max_cards. With max_cards = 2 a member holding one card
  --      passes and receives one more. Act on one, get one; act on both, get two. This deletes a
  --      SECOND, stricter rule that only this path applied — it does not raise anyone's ceiling.
  --
  --      p_release_id stays in the signature: it no longer feeds an eligibility count, but callers
  --      pass it and it is still stamped on a_id's row below as the release envelope.

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
  --     release_id is stamped on a_id's row ONLY. It records which release this card belongs to so a
  --     sibling card of the same release is not treated as prior unanswered work. b_id's card is
  --     deliberately left NULL: it is an independent placement from b_id's point of view.
  INSERT INTO public.intro_requests
    (requester_id, target_user_id, status, is_admin_initiated, match_reason, pair_id, release_id, created_at, updated_at)
  VALUES
    (a_id, b_id, 'suggested', false, p_reason, pair.id, p_release_id, now(), now()),
    (b_id, a_id, 'suggested', false, p_reason, pair.id, NULL,         now(), now());

  UPDATE public.member_pairs
  SET recommend_count = recommend_count + 1,
      last_recommended_at = now(),
      first_recommended_at = coalesce(first_recommended_at, now()),
      status = 'active'
  WHERE id = pair.id;

  RETURN 'created';
END;
$$;
COMMENT ON FUNCTION public.create_reciprocal_suggestion(uuid,uuid,text,text,integer,integer,uuid) IS
  'Two-sided reciprocal placement. Capacity is the DEFICIT: max(0, 2 - visible cards held), enforced '
  'at step (5). Migration 093 removed the binary response-eligibility gate that returned ''unresolved'' '
  'whenever a member held any unanswered card — the admin batch never applied it, so the two paths '
  'disagreed about eligibility.';

-- Verification. A migration that reports success while leaving the gate in place would silently keep
-- coverage and the batch disagreeing, which is the entire defect being fixed.
DO $verify$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'create_reciprocal_suggestion'
  LIMIT 1;

  IF v_src IS NULL THEN
    RAISE EXCEPTION '093 FAILED: create_reciprocal_suggestion is missing after replacement.';
  END IF;
  -- Strip comment lines before checking: the new body DOCUMENTS the removed gate in prose, so a
  -- naive strpos over the whole source matches the explanation rather than live code.
  SELECT string_agg(line, E'\n') INTO v_src
  FROM unnest(string_to_array(v_src, E'\n')) AS line
  WHERE btrim(line) NOT LIKE '--%';

  IF pg_catalog.strpos(v_src, 'count_unresolved_introductions') > 0 THEN
    RAISE EXCEPTION '093 FAILED: the binary unresolved gate is still live in the function body.';
  END IF;
  IF pg_catalog.strpos(v_src, 'a_cards >= max_cards') = 0 THEN
    RAISE EXCEPTION '093 FAILED: the deficit capacity check at step (5) is missing.';
  END IF;
END
$verify$;

COMMIT;
