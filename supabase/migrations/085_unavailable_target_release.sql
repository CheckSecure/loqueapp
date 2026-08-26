-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 085  UNAVAILABLE TARGETS MUST NOT STRAND A MEMBER
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- THE DEFECT. Migration 081 made the response gate STRICT: one unanswered 'suggested' card stops
-- every later placement. Its predicate excluded only targets whose account_status is not 'active'.
-- So a card whose target has since become profile-incomplete, matching-paused, a test account, or
-- who has BLOCKED the member (in either direction) still counted as unresolved — and the member was
-- held out of every future introduction by a person they cannot reasonably be asked to answer, and
-- in the blocking case must not even be shown. A missing target row did worse: the JOIN dropped the
-- card silently, so the member was not stranded but the reason was luck, not design.
--
-- ─── WHAT THIS MIGRATION CHANGES ──────────────────────────────────────────────────────────────
--   1. public.count_unresolved_introductions() — replaced. An UNAVAILABLE target no longer counts.
--   2. resolution_reason gains ONE neutral, system-authored value: 'system_pair_unavailable'.
--   3. public.is_available_intro_target() — the single availability definition.
--   4. public.count_usable_visible_cards() — READ-ONLY usable visible capacity.
--   5. public.neutralize_unavailable_pair() — the ONLY function that physically neutralises, always
--      under both participants' advisory locks, with no bypass argument.
--   6. public.sweep_unavailable_introductions() — the bounded, idempotent maintenance sweep.
--   7. All four writers replaced from their post-081 bodies, with the RAW suggested-row capacity
--      count replaced by the usable one. They mutate nothing new and take no extra lock.
--
-- ─── TWO RESPONSIBILITIES, DELIBERATELY SEPARATED ─────────────────────────────────────────────
--   WRITER TIME is arithmetic only. A writer must never physically neutralise anything: doing so
--     would make it write another member's row and reach for a THIRD advisory lock out of canonical
--     order, which is a deadlock waiting to happen. It simply stops counting what the member cannot
--     use.
--   MAINTENANCE TIME is the only thing that writes, and it always holds both participants' locks,
--     row-locks FOR UPDATE, and re-asserts status in every UPDATE.
--
-- ─── WHY EXCLUDING FROM THE GATE WAS NOT ENOUGH ───────────────────────────────────────────────
-- THE CAPACITY AUTHORITY is a count repeated inline in all four writers:
--     count(*) FROM public.intro_requests
--      WHERE requester_id = <member> AND status = 'suggested' AND capacity_released_at IS NULL
-- It counts EVERY live suggested row, unavailable or not. So correcting only the unresolved
-- predicate produced a member who was told "You're all caught up" while a stale row silently ate
-- one of their two visible slots and they received one introduction a week instead of two.
--
-- Ignoring the row in one count while another authority still counts it is not a fix. The row has
-- to GO — neutrally, atomically, pair-safely — before either count is taken. That is what the
-- writer-time reconciliation does, and it is why the writers themselves are replaced here.
--
-- THE INVARIANT: an unavailable pair must neither block the strict unanswered gate NOR consume a
-- member's usable visible capacity.
--
-- ─── WHY THE REASON NAMES THE PAIR, NOT THE TARGET ────────────────────────────────────────────
-- An earlier draft called it system_target_unavailable. That is untruthful on one of the two rows:
-- if B becomes unavailable, A's card does target an unavailable member — but B's reciprocal card
-- targets A, who is still perfectly available. Both rows are closed together (they are one
-- introduction), so both would have carried a reason that is false on one of them, and anyone
-- reading B's row later would conclude A had become unavailable.
--
-- system_pair_unavailable is true of BOTH rows: the PAIR can no longer be pursued. It says what
-- happened without asserting anything false about either member.
--
-- ─── WHY A NEW RESOLUTION REASON ──────────────────────────────────────────────────────────────
-- Migration 062 constrains resolution_reason to ('not_for_me','never_show','already_know') — three
-- MEMBER choices. Migration 066 hit this exact wall and said so: "No resolution_reason is written,
-- because migration 062 constrains it to (...) and none of those is true here." Writing any of them
-- for a system release would manufacture a member Pass signal — a fabricated negative judgement
-- about a real person, readable later as evidence the member rejected them. It would also feed the
-- matcher's soft history as though the member had decided something.
--
-- 'system_pair_unavailable' is deliberately prefixed system_ so it can never be mistaken for a
-- member choice, and is the forensic record of WHY a card was neutralised.
--
-- ─── WHY THE STATUS IS 'expired' AND NOT A NEW ONE ────────────────────────────────────────────
-- 'expired' is the status migration 066 already uses for a privacy-neutral system close of an
-- unanswered card, the UI already renders it neutrally, and bothMembersConsented already refuses to
-- resurrect it. It is truthful ("this introduction ended without an answer") and says nothing about
-- who acted or why anyone was rejected. 'passed' and 'hidden_permanent' are NOT used: both are
-- member verdicts and both feed intro history as a member decision. No status value is added,
-- renamed or removed, so intro_requests_status_check is untouched.
--
-- ─── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ─────────────────────────────────────────────
--   • NO BACKFILL and no historical cleanup. It rewrites no existing row. Historical rows are
--     REPORTED by supabase/audits/unavailable_target_census.sql and, if the operator decides to,
--     neutralised by supabase/repairs/unavailable_cards_release.PROPOSED.sql — a separate artifact
--     with its own false operator gate.
--   • It creates no match, conversation, notification, email, credit or replacement card, and it
--     calls nothing that does.
--   • It does not change capacity. An un-neutralised stale card still occupies a visible slot, so
--     excluding it from the UNRESOLVED count can never let a member exceed the visible cap — it can
--     only mean they receive fewer cards until the row is neutralised. That is the safe direction.
--   • It does not touch the four writers. They call the predicate by name and pick up the corrected
--     definition without their bodies changing; the guard below proves they are the post-081 ones.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. DRIFT GUARD — FAIL CLOSED ──────────────────────────────────────────────────────────────
DO $guard$
DECLARE
  v_role  text;
  v_oid   oid;
  v_proc  pg_catalog.pg_proc%ROWTYPE;
  v_n     integer;
  r       record;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      RAISE EXCEPTION 'DRIFT GUARD 085: role % does not exist.', v_role;
    END IF;
  END LOOP;

  -- 081 must be applied: this file replaces a function 081 created.
  v_oid := pg_catalog.to_regprocedure('public.count_unresolved_introductions(uuid, uuid, uuid)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'DRIFT GUARD 085: public.count_unresolved_introductions is absent; 081 is not applied.';
  END IF;

  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'count_unresolved_introductions';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'DRIFT GUARD 085: % signatures of count_unresolved_introductions; exactly 1 expected.', v_n;
  END IF;

  SELECT * INTO v_proc FROM pg_catalog.pg_proc WHERE oid = v_oid;

  -- Already applied? Refuse rather than replace a body that may be newer than this file.
  IF pg_catalog.strpos(v_proc.prosrc, 'is_available_intro_target') > 0 THEN
    RAISE EXCEPTION
      'DRIFT GUARD 085: count_unresolved_introductions already excludes unavailable targets; '
      '085 appears to be applied already. Refusing to replace.';
  END IF;

  -- The body being replaced must be EXACTLY the one 081 installs. length() counts characters.
  IF pg_catalog.md5(v_proc.prosrc) <> 'c834301b7374934c88e27e1005959f0a' THEN
    RAISE EXCEPTION
      'DRIFT GUARD 085: count_unresolved_introductions body is not the post-081 one. expected md5 '
      '[c834301b7374934c88e27e1005959f0a] deployed [%] length [%]. 085_preflight.sql reports both.',
      pg_catalog.md5(v_proc.prosrc), pg_catalog.length(v_proc.prosrc);
  END IF;
  IF pg_catalog.length(v_proc.prosrc) <> 1129 THEN
    RAISE EXCEPTION 'DRIFT GUARD 085: predicate body length is %, expected 1129.',
      pg_catalog.length(v_proc.prosrc);
  END IF;
  IF NOT v_proc.prosecdef THEN
    RAISE EXCEPTION 'DRIFT GUARD 085: the predicate is no longer SECURITY DEFINER.';
  END IF;

  -- The four writers must be the post-081 ones: each deployed exactly once, and each already
  -- calling the predicate (which is what proves 081's gate is in force and is what will pick up
  -- the corrected definition without their bodies changing).
  FOR r IN
    SELECT * FROM (VALUES
      ('create_reciprocal_suggestion'::text, 'public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer, uuid)'::text),
      ('place_batch_rows',                   'public.place_batch_rows(uuid, text, jsonb, uuid, integer)'),
      ('promote_queued_rows',                'public.promote_queued_rows(uuid)'),
      ('materialize_admin_pair',             'public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer)')
    ) AS t(fname, sig)
  LOOP
    IF pg_catalog.to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'DRIFT GUARD 085: % is not deployed under that exact signature.', r.sig;
    END IF;
    SELECT count(*) INTO v_n FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fname;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'DRIFT GUARD 085: public.% has % signatures; exactly 1 expected.', r.fname, v_n;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = r.fname
         AND pg_catalog.strpos(p.prosrc, 'count_unresolved_introductions') > 0
    ) THEN
      RAISE EXCEPTION
        'DRIFT GUARD 085: public.% does not call count_unresolved_introductions; 081''s response '
        'gate is not in force and correcting the predicate would fix nothing.', r.fname;
    END IF;
  END LOOP;

  -- Tables this file's logic depends on.
  IF pg_catalog.to_regclass('public.blocked_users') IS NULL THEN
    RAISE EXCEPTION 'DRIFT GUARD 085: public.blocked_users does not exist.';
  END IF;
  FOR r IN SELECT * FROM (VALUES ('profile_complete'),('is_test_account'),('matching_paused'),('account_status')) AS t(col)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                    WHERE attrelid = 'public.profiles'::pg_catalog.regclass
                      AND attname = r.col AND NOT attisdropped) THEN
      RAISE EXCEPTION 'DRIFT GUARD 085: public.profiles.% is absent.', r.col;
    END IF;
  END LOOP;
END
$guard$;

-- ── 2. THE NEUTRAL, SYSTEM-AUTHORED RESOLUTION REASON ─────────────────────────────────────────
-- Widening a CHECK only. Every existing row remains valid; nothing is rewritten. NULL stays legal
-- (062's meaning: "dismissed before reasons were recorded"), and the three member choices are
-- unchanged and still the only values any member-facing path may write.
ALTER TABLE public.intro_requests
  DROP CONSTRAINT IF EXISTS intro_requests_resolution_reason_check;
ALTER TABLE public.intro_requests
  ADD CONSTRAINT intro_requests_resolution_reason_check
  CHECK (
    resolution_reason IS NULL
    OR resolution_reason IN ('not_for_me', 'never_show', 'already_know', 'system_pair_unavailable')
  );

COMMENT ON COLUMN public.intro_requests.resolution_reason IS
  'Why a recommendation was resolved. MEMBER choices: not_for_me (declined the fit) | never_show | '
  'already_know (an existing relationship — NOT a negative-quality signal). SYSTEM reason: '
  'system_pair_unavailable (085 — the target became missing/inactive/incomplete/test/paused, or a '
  'block exists in either direction, so the member could not be asked to answer it). A system reason '
  'is NEVER a member verdict and must never be read as a Pass, a rejection or a quality signal. '
  'NULL = resolved before reasons were recorded; never backfilled or inferred.';

-- ── 3. THE ROW-SHAPE PREDICATES, STATED ONCE ─────────────────────────────────────────────────
-- Migrations 080 and 081 put two DIFFERENT kinds of row in public.intro_requests, and every defect
-- in the previous draft of this file came from not separating them:
--
--   PLACEMENT CARD     responds_to_id IS NULL.  The introduction itself. Created by the four
--                      writers. Its status IS its lifecycle: suggested -> answered/terminal.
--   CORRELATED RESPONSE responds_to_id IS NOT NULL.  A member's authored answer to a specific card
--                      (migration 080). Never a card. Carries pair_id NULL. IMMUTABLE EVIDENCE:
--                      nothing in this file may update, expire or delete one.
--
-- Derived predicates, used verbatim everywhere below:
--   IN-PLACE INTEREST     placement card whose own status is in the interest set (the
--                         express-interest route moves 'suggested' -> 'approved' on the card).
--   CORRELATED INTEREST   a response row with responds_to_id = <card id> in the interest set.
--   PASS                  placement card with status 'passed' or 'hidden_permanent'.
--   ACTIONABLE CARD       placement card, status 'suggested', target AVAILABLE.
--   UNAVAILABLE CARD      placement card, status 'suggested', target NOT available.
--
-- A card whose status has left 'suggested' carries a MEMBER DECISION and is never rewritten here.

-- Availability, in one place, so the gate, the capacity count and the neutraliser cannot disagree.
CREATE OR REPLACE FUNCTION public.is_available_intro_target(p_member_id uuid, p_target_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles t
     WHERE t.id = p_target_id
       AND t.account_status = 'active'
       AND t.profile_complete IS TRUE
       AND t.is_test_account IS NOT TRUE
       AND t.matching_paused IS NOT TRUE
  ) AND NOT EXISTS (
    SELECT 1 FROM public.blocked_users bu
     WHERE (bu.user_id = p_member_id AND bu.blocked_user_id = p_target_id)
        OR (bu.user_id = p_target_id AND bu.blocked_user_id = p_member_id)
  );
$fn$;

REVOKE ALL ON FUNCTION public.is_available_intro_target(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_available_intro_target(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.is_available_intro_target(uuid, uuid) IS
  'THE single definition of "this member can, and may, be asked to answer an introduction to that '
  'member": target exists, is active, complete, non-test, not matching-paused, and no block exists '
  'in either direction. Read-only. Used by the unresolved gate, the usable-capacity count and the '
  'maintenance neutraliser so none of them can drift from the others. See 085.';

-- ── 4. THE CORRECTED UNRESOLVED GATE ─────────────────────────────────────────────────────────
-- 081's body plus two corrections: only PLACEMENT cards count, and the target must be available.
CREATE OR REPLACE FUNCTION public.count_unresolved_introductions(
  p_member_id       uuid,
  p_exclude_release uuid DEFAULT NULL,
  p_exclude_batch   uuid DEFAULT NULL
) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT count(*)::integer
  FROM public.intro_requests s
  WHERE s.requester_id = p_member_id
    AND s.responds_to_id IS NULL          -- PLACEMENT cards only; a response row is not a card
    AND s.status = 'suggested'
    AND (p_exclude_release IS NULL OR s.release_id IS DISTINCT FROM p_exclude_release)
    AND (p_exclude_batch   IS NULL OR s.batch_id   IS DISTINCT FROM p_exclude_batch)
    AND public.is_available_intro_target(p_member_id, s.target_user_id)   -- 085
    AND NOT EXISTS (
      SELECT 1 FROM public.intro_requests e
       WHERE e.requester_id   = p_member_id
         AND e.target_user_id = s.target_user_id
         AND e.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending'))
    AND NOT EXISTS (
      SELECT 1 FROM public.intro_requests inb
       WHERE inb.requester_id   = s.target_user_id
         AND inb.target_user_id = p_member_id
         AND inb.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending'))
    AND NOT EXISTS (
      SELECT 1 FROM public.matches m
       WHERE (m.user_a_id = p_member_id AND m.user_b_id = s.target_user_id)
          OR (m.user_a_id = s.target_user_id AND m.user_b_id = p_member_id));
$fn$;

REVOKE ALL ON FUNCTION public.count_unresolved_introductions(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_unresolved_introductions(uuid, uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.count_unresolved_introductions(uuid, uuid, uuid) IS
  'THE authoritative count of introductions this member has not answered AND can actually answer: '
  'PLACEMENT cards (responds_to_id IS NULL) still ''suggested'' whose target is available by '
  'public.is_available_intro_target, where the member holds no outbound expression, the target has '
  'expressed no inbound interest, and no match exists. release_id / batch_id name the CURRENT '
  'release so its sibling cards do not block each other. See 081 + 085.';

-- ── 5. USABLE VISIBLE CAPACITY — read-only, and the whole of the writer-side fix ──────────────
-- RAW suggested rows are NOT the same thing as usable visible cards, and conflating them is what
-- made a member silently receive one introduction a week instead of two:
--
--   RAW      every placement card still 'suggested' with capacity_released_at IS NULL. Includes
--            stale rows pointing at members who became unavailable. May exceed the cap while those
--            rows await maintenance — that is a historical artifact, not a live over-allocation.
--   USABLE   the same, minus unavailable targets. This is what the member can see and answer, and
--            it is the ONLY number placement is allowed to reason about.
--
-- The writers now call this instead of counting raw rows. Nothing is mutated to achieve it: a stale
-- row simply stops being counted, by the same availability predicate that hides it from the page
-- and excludes it from the gate. No third advisory lock, no write to another member's row.
--
-- THE CAP STILL HOLDS. Placement is bounded by (c_max_visible - usable), so USABLE can never exceed
-- c_max_visible. RAW may sit above it until the neutraliser runs; every user-facing count and every
-- placement decision uses USABLE, so no member is ever shown or allocated more than the cap.
CREATE OR REPLACE FUNCTION public.count_usable_visible_cards(p_member_id uuid)
  RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT count(*)::integer
  FROM public.intro_requests ir
  WHERE ir.requester_id = p_member_id
    AND ir.responds_to_id IS NULL             -- PLACEMENT cards only
    AND ir.status = 'suggested'
    AND ir.capacity_released_at IS NULL       -- unchanged from 063/080
    AND public.is_available_intro_target(p_member_id, ir.target_user_id);   -- 085
$fn$;

REVOKE ALL ON FUNCTION public.count_usable_visible_cards(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_usable_visible_cards(uuid) TO service_role;

COMMENT ON FUNCTION public.count_usable_visible_cards(uuid) IS
  'Visible introduction slots this member is ACTUALLY using: placement cards still ''suggested'', '
  'not capacity-released, whose target is available. Read-only. The four writers use this instead '
  'of a raw suggested-row count, so a stale unavailable row cannot consume a slot — without any '
  'writer mutating another member''s row or taking a third advisory lock. RAW suggested rows may '
  'exceed the cap until maintenance neutralises them; USABLE never can. See 085.';

-- ── 6. THE LOCKED MAINTENANCE NEUTRALISER — the ONLY thing that writes ───────────────────────
-- There is exactly one entry point, it always takes both participants' advisory locks in canonical
-- UUID order, and there is NO argument that can bypass them. Everything it touches is re-read after
-- the locks are held and row-locked FOR UPDATE in deterministic id order.
--
-- WHAT IT WILL NOT DO, and these are the rules the previous draft broke:
--   • It never reads a row it intends to change without FOR UPDATE.
--   • It never updates by id alone: every UPDATE re-asserts status = 'suggested', so a response
--     that commits between the lock and the write cannot be overwritten.
--   • It never selects a counterpart with LIMIT 1 over heterogeneous rows. The counterpart must be
--     a PLACEMENT card (responds_to_id IS NULL) in the exact reversed direction. Two or more
--     matching rows is a MALFORMED pair: it returns 'malformed' and changes nothing.
--   • It never rewrites a correlated response row. Those are authored evidence and are read only.
--   • It never touches a card whose status has left 'suggested' — that status is a member decision.
--
-- MUTUAL INTEREST ON AN UNAVAILABLE PAIR is closed, not refused. Both members answered, but the
-- introduction can no longer be pursued (one is gone, or a block now exists), so leaving the cards
-- open would promise a match that must never be created. The placement lifecycle closes neutrally,
-- member_pairs becomes 'expired', and BOTH authored interest rows are preserved untouched.
-- public.finalize_mutual_match already refuses a pair whose status is 'expired' or 'blocked', so
-- the preserved evidence can never later produce an invalid match.
CREATE OR REPLACE FUNCTION public.neutralize_unavailable_pair(p_card_id uuid)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $fn$
DECLARE
  c_interest CONSTANT text[] := ARRAY['pending','approved','accepted','accepted_pending_payment','admin_pending'];
  v_peek     public.intro_requests%ROWTYPE;
  v_card     public.intro_requests%ROWTYPE;
  v_other    public.intro_requests%ROWTYPE;
  v_lo       uuid;
  v_hi       uuid;
  v_n        integer;
  v_ids      uuid[];
  v_closed   integer := 0;
  v_pair     text := 'not_a_pair';
  v_mutual   boolean := false;
  v_i_self   boolean;
  v_i_other  boolean;
BEGIN
  IF p_card_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome','not_found','closed',0);
  END IF;

  -- (0) Unlocked peek, ONLY to learn who the two participants are so the locks can be taken in
  --     canonical order. Nothing is decided from this read; every fact is re-read under the locks.
  SELECT * INTO v_peek FROM public.intro_requests WHERE id = p_card_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('outcome','not_found','closed',0);
  END IF;

  -- (1) BOTH participants' advisory locks, canonical UUID order. Same key space as every writer.
  v_lo := LEAST(v_peek.requester_id, v_peek.target_user_id);
  v_hi := GREATEST(v_peek.requester_id, v_peek.target_user_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lo::text, 0));
  IF v_hi IS DISTINCT FROM v_lo THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_hi::text, 0));
  END IF;

  -- (2) Re-read the card FOR UPDATE. Everything below is decided from this row, not the peek.
  SELECT * INTO v_card FROM public.intro_requests WHERE id = p_card_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('outcome','not_found','closed',0);
  END IF;
  IF v_card.responds_to_id IS NOT NULL THEN
    -- A correlated response row is authored evidence, not a card. Never neutralised.
    RETURN pg_catalog.jsonb_build_object('outcome','not_a_placement_card','closed',0);
  END IF;
  IF v_card.status <> 'suggested' THEN
    -- The member answered (or it is otherwise terminal) between selection and now. Their decision.
    RETURN pg_catalog.jsonb_build_object('outcome','not_actionable','closed',0);
  END IF;

  -- (3) Availability re-read under the lock: a block or deactivation that commits during selection
  --     is seen here, and a target that became available again is refused.
  IF public.is_available_intro_target(v_card.requester_id, v_card.target_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','target_available','closed',0);
  END IF;

  -- (4) Never pre-empt a real connection.
  IF EXISTS (SELECT 1 FROM public.matches m
              WHERE (m.user_a_id = v_card.requester_id AND m.user_b_id = v_card.target_user_id)
                 OR (m.user_a_id = v_card.target_user_id AND m.user_b_id = v_card.requester_id)) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','matched','closed',0);
  END IF;

  IF v_card.pair_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.member_pairs mp
                WHERE mp.id = v_card.pair_id AND mp.status = 'matched') THEN
      RETURN pg_catalog.jsonb_build_object('outcome','finalized','closed',0);
    END IF;

    -- (5) THE COUNTERPART, by the audited PLACEMENT-CARD predicate — never LIMIT 1 over a mixed set.
    SELECT count(*), pg_catalog.array_agg(x.id ORDER BY x.id) INTO v_n, v_ids
      FROM public.intro_requests x
     WHERE x.pair_id        = v_card.pair_id
       AND x.id            <> v_card.id
       AND x.responds_to_id IS NULL                       -- placement card, not a response
       AND x.requester_id   = v_card.target_user_id       -- exact reversed direction
       AND x.target_user_id = v_card.requester_id;

    IF v_n > 1 THEN
      -- More than one reversed placement card for one pair is a shape nobody designed. Refuse and
      -- leave every row untouched so it can be investigated.
      RETURN pg_catalog.jsonb_build_object('outcome','malformed','closed',0,
        'detail','multiple reversed placement cards for this pair','count',v_n);
    END IF;

    IF v_n = 1 THEN
      -- (6) Row-lock it too, in deterministic id order relative to the card already locked.
      SELECT * INTO v_other FROM public.intro_requests WHERE id = v_ids[1] FOR UPDATE;
    END IF;
  END IF;

  -- (7) INTEREST, detected through BOTH supported mechanisms, on BOTH sides.
  v_i_self := (v_card.status = ANY(c_interest)) OR EXISTS (
    SELECT 1 FROM public.intro_requests e
     WHERE e.responds_to_id = v_card.id AND e.status = ANY(c_interest));
  v_i_other := v_other.id IS NOT NULL AND (
    (v_other.status = ANY(c_interest)) OR EXISTS (
      SELECT 1 FROM public.intro_requests e
       WHERE e.responds_to_id = v_other.id AND e.status = ANY(c_interest)));
  v_mutual := v_i_self AND v_i_other;

  -- (8) Close the counterpart — ONLY if it is still an unanswered placement card. Status is
  --     re-asserted in the WHERE clause, so a response committed since the lock cannot be lost.
  IF v_other.id IS NOT NULL THEN
    IF v_other.status = 'suggested' THEN
      UPDATE public.intro_requests
         SET status = 'expired',
             resolution_reason = 'system_pair_unavailable',
             updated_at = pg_catalog.now()
       WHERE id = v_other.id AND status = 'suggested' AND responds_to_id IS NULL;
      IF FOUND THEN v_closed := v_closed + 1; v_pair := 'both_sides_closed';
      ELSE v_pair := 'counterpart_changed_concurrently'; END IF;
    ELSE
      -- The counterpart carries a member decision. Left exactly as it is.
      v_pair := 'counterpart_authored';
    END IF;
  ELSIF v_card.pair_id IS NOT NULL THEN
    v_pair := 'counterpart_row_missing';
  END IF;

  -- (9) Close this card, with the same status re-assertion.
  UPDATE public.intro_requests
     SET status = 'expired',
         resolution_reason = 'system_pair_unavailable',
         updated_at = pg_catalog.now()
   WHERE id = v_card.id AND status = 'suggested' AND responds_to_id IS NULL;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('outcome','changed_concurrently','closed',v_closed,'pair',v_pair);
  END IF;
  v_closed := v_closed + 1;

  -- (10) TRUTHFUL member_pairs state. 'matched' and 'blocked' are never overwritten; the pair is
  --      marked 'expired' once no placement card of it is still 'suggested'. finalize_mutual_match
  --      refuses an 'expired' pair, so preserved interest evidence cannot become an invalid match.
  IF v_card.pair_id IS NOT NULL THEN
    UPDATE public.member_pairs
       SET status = 'expired', updated_at = pg_catalog.now()
     WHERE id = v_card.pair_id
       AND status NOT IN ('matched','blocked','expired')
       AND NOT EXISTS (SELECT 1 FROM public.intro_requests x
                        WHERE x.pair_id = v_card.pair_id
                          AND x.responds_to_id IS NULL
                          AND x.status = 'suggested');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'outcome','released','closed',v_closed,'pair',v_pair,
    'mutual_interest_preserved', v_mutual,
    'interest_rows_preserved', (
      SELECT count(*)::integer FROM public.intro_requests e
       WHERE e.responds_to_id IN (v_card.id, COALESCE(v_other.id, v_card.id))));
END
$fn$;

REVOKE ALL ON FUNCTION public.neutralize_unavailable_pair(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.neutralize_unavailable_pair(uuid) TO service_role;

COMMENT ON FUNCTION public.neutralize_unavailable_pair(uuid) IS
  'THE ONLY function that physically neutralises an unavailable introduction. Always takes both '
  'participants advisory locks in canonical UUID order — there is no bypass argument. Re-reads and '
  'row-locks every row it changes FOR UPDATE, re-asserts status = ''suggested'' in every UPDATE, '
  'identifies the counterpart by the exact placement-card predicate (never LIMIT 1), and returns '
  '''malformed'' unchanged if the pair has an unexpected shape. Never rewrites a correlated '
  'response row or any card carrying a member decision. Closes a mutually-interested but now '
  'unavailable pair neutrally, preserving both authored interest rows; finalize_mutual_match then '
  'refuses the expired pair. Creates no match, conversation, message, notification, email, credit '
  'or replacement card. See 085.';

-- ── 7. THE BOUNDED MAINTENANCE SWEEP ─────────────────────────────────────────────────────────
-- Ongoing tidy-up. It is NOT the correctness mechanism: the writers already ignore unavailable
-- rows when computing usable capacity and the unresolved gate, so a delayed, truncated or failed
-- sweep cannot reduce anyone's allocation or strand anyone. This only stops raw suggested rows
-- accumulating and keeps member_pairs truthful.
--
-- Every write is delegated to public.neutralize_unavailable_pair, which takes the canonical locks
-- itself. The sweep holds none of its own and passes no bypass — there is none to pass.
CREATE OR REPLACE FUNCTION public.sweep_unavailable_introductions(p_limit integer DEFAULT 100)
  RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $fn$
DECLARE
  v_limit     integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  r           record;
  v_out       jsonb;
  v_processed integer := 0;
  v_released  integer := 0;
  v_skipped   integer := 0;
  v_failed    integer := 0;
  v_outcomes  jsonb := '{}'::jsonb;
  v_key       text;
BEGIN
  FOR r IN
    SELECT s.id
      FROM public.intro_requests s
     WHERE s.responds_to_id IS NULL            -- placement cards only
       AND s.status = 'suggested'
       AND NOT public.is_available_intro_target(s.requester_id, s.target_user_id)
     ORDER BY s.created_at, s.id               -- deterministic: oldest first
     LIMIT v_limit
  LOOP
    v_processed := v_processed + 1;
    BEGIN
      -- Re-validated under the locks inside the neutraliser. A card that became available, was
      -- answered, or was already closed as an earlier iteration's counterpart is REFUSED there.
      v_out := public.neutralize_unavailable_pair(r.id);
      v_key := COALESCE(v_out ->> 'outcome', 'unknown');
      v_outcomes := pg_catalog.jsonb_set(
        v_outcomes, ARRAY[v_key],
        pg_catalog.to_jsonb(COALESCE((v_outcomes ->> v_key)::integer, 0) + 1), true);
      IF v_key = 'released' THEN v_released := v_released + 1; ELSE v_skipped := v_skipped + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One card can never abort the sweep, and nothing about the member is recorded: the SQLSTATE
      -- class is the entire diagnostic.
      v_failed := v_failed + 1;
      v_outcomes := pg_catalog.jsonb_set(
        v_outcomes, ARRAY['error_' || SQLSTATE],
        pg_catalog.to_jsonb(COALESCE((v_outcomes ->> ('error_' || SQLSTATE))::integer, 0) + 1), true);
    END;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'processed', v_processed, 'released', v_released, 'skipped', v_skipped, 'failed', v_failed,
    'limit', v_limit, 'truncated', v_processed >= v_limit, 'outcomes', v_outcomes);
END
$fn$;

REVOKE ALL ON FUNCTION public.sweep_unavailable_introductions(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_unavailable_introductions(integer) TO service_role;

COMMENT ON FUNCTION public.sweep_unavailable_introductions(integer) IS
  'Bounded, idempotent, concurrency-safe maintenance sweep that neutralises unavailable placement '
  'cards, oldest first, through public.neutralize_unavailable_pair under the canonical member '
  'advisory locks. Returns aggregate processed/released/skipped/failed counts and never emits '
  'member data. Not the correctness mechanism: the writers compute usable capacity read-only, so a '
  'delayed sweep cannot reduce anyone''s allocation. See 085.';

-- ── 8. THE FOUR WRITERS, USING USABLE CAPACITY ───────────────────────────────────────────────
-- Replaced from their EXACT post-081 bodies. The ONLY change to each is that the raw
-- suggested-row capacity count is replaced by public.count_usable_visible_cards(). They mutate
-- nothing new, take no additional lock, and touch no other member's row — the entire writer-side
-- fix is arithmetic. Everything else is byte-for-byte what 081 installed: the release/batch
-- envelope, the visible cap constant, reciprocal atomicity, cooldown and history, and the
-- duplicate-placement guards.

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
  -- (085) USABLE visible capacity, not raw suggested rows: a stale card pointing at somebody who
  -- became unavailable is not a slot this member can use, and must not cost them an introduction.
  -- Read-only — nothing is mutated and no extra lock is taken. Physical neutralisation belongs to
  -- the locked maintenance authority (section 6), never to a writer.
  a_cards := public.count_usable_visible_cards(a_id);
  b_cards := public.count_usable_visible_cards(b_id);
  IF a_cards >= max_cards OR b_cards >= max_cards THEN
    RETURN 'capacity';
  END IF;

  -- (5b) RESPONSE ELIGIBILITY (migration 081). A member must answer every actionable introduction
  --      they already hold before a LATER release, or an INDEPENDENT reciprocal placement, may put
  --      another card in front of them.
  --
  --      THE RELEASE ENVELOPE IS WHAT MAKES THIS NOT A NAIVE RULE. generateReciprocalBatchForMember
  --      places up to c_max_visible cards for a_id by calling this function once per candidate. Card
  --      1 of a release would otherwise make card 2 of the SAME release illegal. p_release_id names
  --      that envelope and is excluded from a_id's count, so a two-card onboarding or weekly release
  --      still lands intact while one card left over from an EARLIER release blocks it.
  --
  --      b_id gets NO exclusion. b_id is not part of a_id's release — they are the counterpart of
  --      somebody else's independent introduction — so they must be genuinely clear. That is also
  --      why only a_id's row carries release_id below: an envelope can never exempt the far side.
  --
  --      A borrowed release id buys nothing: the visible cap in (5) is enforced first and counts
  --      every unreleased 'suggested' row regardless of release_id, so a_id can still never exceed
  --      c_max_visible cards.
  IF public.count_unresolved_introductions(a_id, p_release_id, NULL) > 0 THEN
    RETURN 'unresolved';
  END IF;
  IF public.count_unresolved_introductions(b_id, NULL, NULL) > 0 THEN
    RETURN 'unresolved';
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

CREATE OR REPLACE FUNCTION public.place_batch_rows(
  p_member_id uuid,
  p_source text,
  p_rows jsonb,
  p_reciprocal_batch_id uuid DEFAULT NULL,
  p_cooldown_days integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_max_visible  constant integer := 2;    -- THE visible cap  (status 'suggested')
  c_max_reserved constant integer := 2;    -- THE reserved cap (status 'queued')
  c_max_rows     constant integer := 50;   -- payload bound; a batch is 2 rows, 50 is generous
  c_uuid         constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_active    public.recommendation_batches%ROWTYPE;
  v_queued    public.recommendation_batches%ROWTYPE;
  v_n_active  integer;
  v_n_queued  integer;
  v_visible   integer;
  v_reserved  integer;
  v_visible_free  integer;
  v_reserved_free integer;
  v_supplied   integer;
  v_candidates jsonb;
  v_n_cand     integer;
  v_take_v     integer := 0;
  v_take_r     integer := 0;
  v_active_id  uuid := NULL;
  v_queued_id  uuid := NULL;
  v_cutoff     timestamptz := now() - make_interval(days => GREATEST(coalesce(p_cooldown_days, 30), 0));
  v_now        timestamptz := now();
BEGIN
  ------------------------------------------------------------------ validation (no writes)
  IF p_member_id IS NULL THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'invalid');
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('onboarding','weekly','admin_reciprocal','migration') THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'invalid');
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'invalid');
  END IF;

  v_supplied := jsonb_array_length(p_rows);
  IF v_supplied = 0 THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'empty');
  END IF;
  IF v_supplied > c_max_rows THEN
    -- Refuse outright rather than silently taking a prefix: an oversized payload means the caller is
    -- not the producer this function was designed for, and truncating would hide that.
    RETURN jsonb_build_object('placed', false, 'reason', 'too_many_rows', 'dropped', v_supplied);
  END IF;

  ------------------------------------------------------------------ (0) lock, THEN read anything
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_member_id::text, 0));

  ------------------------------------------------------------------ (1) the MEMBER must be eligible
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_member_id
      AND p.account_status = 'active'
      AND p.profile_complete = true
      AND coalesce(p.is_test_account, false) = false
      AND coalesce(p.is_admin, false) = false
      AND coalesce(p.matching_paused, false) = false
      AND p.email <> 'bizdev91@gmail.com'
  ) THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'ineligible');
  END IF;

  ------------------------------------------------------------------ (2) candidates, computed ONCE
  -- Parsed → uuid-screened → non-self → de-duplicated (FIRST occurrence wins, so ranker order is
  -- preserved) → target eligible → not blocked → not matched → no live intro → not in cooldown.
  -- Materialised into a jsonb array so the set is evaluated exactly once and the inserts below
  -- cannot drift from the counts. A temp table is deliberately not used: it would not resolve under
  -- `search_path = ''` and would collide when two placements share a transaction.
  SELECT jsonb_agg(jsonb_build_object('t', f.target_user_id, 'r', f.match_reason) ORDER BY f.rank)
    INTO v_candidates
  FROM (
    WITH parsed AS (
      SELECT e.value ->> 'target_user_id' AS raw_target,
             nullif(e.value ->> 'match_reason', '') AS match_reason,
             e.ordinality AS rank
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(value, ordinality)
    ),
    -- MATERIALIZED is load-bearing, not decoration. Postgres does not guarantee that a WHERE
    -- predicate runs before a cast in the same query level, so `WHERE raw_target ~* c_uuid` cannot
    -- protect `raw_target::uuid` from raising 22P02 on a malformed value. Materialising the screen
    -- forces the filter to complete first, which is what makes a hostile payload drop cleanly
    -- instead of aborting the transaction with a raw SQL error.
    screened AS MATERIALIZED (
      SELECT raw_target, match_reason, rank
      FROM parsed
      WHERE raw_target IS NOT NULL
        AND raw_target ~* c_uuid                       -- cast only what is syntactically a uuid
    ),
    valid AS (
      SELECT (raw_target)::uuid AS target_user_id, match_reason, rank
      FROM screened
      WHERE (raw_target)::uuid <> p_member_id          -- a self-pair is never a recommendation
    ),
    deduped AS (
      SELECT DISTINCT ON (target_user_id) target_user_id, match_reason, rank
      FROM valid ORDER BY target_user_id, rank
    )
    SELECT d.* FROM deduped d
    -- the target exists AND is eligible (this also guarantees the FK below can never fail)
    WHERE EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = d.target_user_id
        AND p.account_status = 'active'
        AND p.profile_complete = true
        AND coalesce(p.is_test_account, false) = false
        AND coalesce(p.is_admin, false) = false
        AND coalesce(p.matching_paused, false) = false
        AND p.email <> 'bizdev91@gmail.com'
    )
    -- not blocked in either direction
    AND NOT EXISTS (
      SELECT 1 FROM public.blocked_users bu
      WHERE (bu.user_id = p_member_id AND bu.blocked_user_id = d.target_user_id)
         OR (bu.user_id = d.target_user_id AND bu.blocked_user_id = p_member_id)
    )
    -- not already connected (matches is column-ordered → check both orders)
    AND NOT EXISTS (
      SELECT 1 FROM public.matches m
      WHERE (m.user_a_id = p_member_id AND m.user_b_id = d.target_user_id)
         OR (m.user_a_id = d.target_user_id AND m.user_b_id = p_member_id)
    )
    -- no live/committed intro in EITHER direction, and no RECENT soft dismissal. Identical to the
    -- reciprocal RPC's step (4), so the two paths cannot disagree about what "already introduced"
    -- means. This subsumes the old same-direction dedupe.
    AND NOT EXISTS (
      SELECT 1 FROM public.intro_requests ir
      WHERE ((ir.requester_id = p_member_id AND ir.target_user_id = d.target_user_id)
          OR (ir.requester_id = d.target_user_id AND ir.target_user_id = p_member_id))
        AND (
          ir.status IN ('suggested','queued','pending','accepted','accepted_pending_payment',
                        'admin_pending','approved','declined','rejected','hidden','hidden_permanent')
          OR (ir.status IN ('passed','expired') AND ir.updated_at >= v_cutoff)
        )
    )
  ) f;

  v_n_cand := coalesce(jsonb_array_length(v_candidates), 0);
  IF v_n_cand = 0 THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'no_eligible_candidates',
      'visible_placed', 0, 'reserved_placed', 0, 'dropped', v_supplied);
  END IF;

  ------------------------------------------------------------------ (3) capacity from CARD COUNTS
  -- Status alone decides. batch_id and pair_id are deliberately not consulted: a reciprocal card and
  -- a legacy batch card occupy the same slot.
  SELECT count(*) FILTER (WHERE ir.status = 'queued')
    INTO v_reserved
  FROM public.intro_requests ir
  WHERE ir.requester_id = p_member_id;

  SELECT count(*) INTO v_n_active FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'active';
  SELECT count(*) INTO v_n_queued FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'queued';
  IF v_n_active > 1 OR v_n_queued > 1 THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'inconsistent_batches');
  END IF;

  SELECT * INTO v_active FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'active' FOR UPDATE;
  SELECT * INTO v_queued FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'queued' FOR UPDATE;

  -- (085) USABLE visible capacity — see count_usable_visible_cards. Read-only.
  v_visible := public.count_usable_visible_cards(p_member_id);
  v_visible_free  := GREATEST(0, c_max_visible  - v_visible);
  v_reserved_free := GREATEST(0, c_max_reserved - v_reserved);

  -- RESPONSE ELIGIBILITY (migration 081). Unresolved work from an EARLIER release blocks this one.
  -- v_active.batch_id is the envelope: rows already placed into the batch this call appends to are
  -- siblings of this release, not prior work, so they are excluded. When no active batch exists the
  -- exclusion is NULL and every unresolved row counts — which is correct, because a brand-new batch
  -- is by definition a later release than anything already on the member's screen.
  IF public.count_unresolved_introductions(p_member_id, NULL, v_active.batch_id) > 0 THEN
    RETURN jsonb_build_object('placed', false, 'reason', 'unresolved',
      'visible_placed', 0, 'reserved_placed', 0, 'dropped', v_supplied);
  END IF;

  -- Provenance guard: append only into a batch of the SAME source, else skip that tier untouched.
  IF v_visible_free > 0 AND (v_active.batch_id IS NULL OR v_active.batch_source = p_source) THEN
    v_take_v := LEAST(v_visible_free, v_n_cand);
  END IF;
  IF v_reserved_free > 0 AND (v_queued.batch_id IS NULL OR v_queued.batch_source = p_source) THEN
    v_take_r := LEAST(v_reserved_free, v_n_cand - v_take_v);
  END IF;

  IF v_take_v = 0 AND v_take_r = 0 THEN
    -- Fail closed, everything unchanged. 'reserved_full' when the reserved tier was the only one
    -- that could have been used; 'visible_full' when neither tier had room at all.
    RETURN jsonb_build_object(
      'placed', false,
      'reason', CASE
                  WHEN v_visible_free = 0 AND v_reserved_free = 0 THEN 'at_capacity'
                  WHEN v_reserved_free = 0 THEN 'reserved_full'
                  ELSE 'source_mismatch'
                END,
      'visible_placed', 0, 'reserved_placed', 0, 'dropped', v_supplied);
  END IF;

  ------------------------------------------------------------------ (4) writes, contiguous, last
  -- Everything above this line is read-only, so every refusal returns with the database untouched.
  -- There is no DELETE and no discard anywhere below: nothing is ever evicted.
  IF v_take_v > 0 THEN
    IF v_active.batch_id IS NULL THEN
      v_active_id := gen_random_uuid();
      INSERT INTO public.recommendation_batches
        (batch_id, member_id, batch_source, state, reciprocal_batch_id,
         created_at, generated_at, displayed_at, completed_at)
      VALUES (v_active_id, p_member_id, p_source, 'active', p_reciprocal_batch_id,
              v_now, v_now, v_now, NULL);
    ELSE
      v_active_id := v_active.batch_id;   -- append; never a second active batch
    END IF;

    INSERT INTO public.intro_requests
      (requester_id, target_user_id, status, match_reason, batch_id, created_at, updated_at)
    SELECT p_member_id, (c.value ->> 't')::uuid, 'suggested', c.value ->> 'r', v_active_id, v_now, v_now
    FROM jsonb_array_elements(v_candidates) WITH ORDINALITY AS c(value, ordinality)
    WHERE c.ordinality <= v_take_v;
  END IF;

  IF v_take_r > 0 THEN
    IF v_queued.batch_id IS NULL THEN
      v_queued_id := gen_random_uuid();
      INSERT INTO public.recommendation_batches
        (batch_id, member_id, batch_source, state, reciprocal_batch_id,
         created_at, generated_at, displayed_at, completed_at)
      VALUES (v_queued_id, p_member_id, p_source, 'queued', p_reciprocal_batch_id,
              v_now, v_now, NULL, NULL);
    ELSE
      v_queued_id := v_queued.batch_id;   -- append; never a second queued batch
    END IF;

    INSERT INTO public.intro_requests
      (requester_id, target_user_id, status, match_reason, batch_id, created_at, updated_at)
    SELECT p_member_id, (c.value ->> 't')::uuid, 'queued', c.value ->> 'r', v_queued_id, v_now, v_now
    FROM jsonb_array_elements(v_candidates) WITH ORDINALITY AS c(value, ordinality)
    WHERE c.ordinality > v_take_v AND c.ordinality <= v_take_v + v_take_r;
  END IF;

  RETURN jsonb_build_object(
    'placed', true,
    'visible_placed', v_take_v,
    'reserved_placed', v_take_r,
    'dropped', v_supplied - v_take_v - v_take_r,
    'active_batch_id', v_active_id,
    'queued_batch_id', v_queued_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.promote_queued_rows(
  p_member_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_max_visible constant integer := 2;   -- THE visible cap. Fixed here; no argument can raise it.
  v_active     public.recommendation_batches%ROWTYPE;
  v_queued     public.recommendation_batches%ROWTYPE;
  v_n_active   integer;
  v_n_queued   integer;
  v_unresolved integer;
  v_visible    integer;
  v_free       integer;
  v_promoted   integer;
  v_leftover   integer;
  v_split      uuid := NULL;
  v_completed  uuid := NULL;
  v_now        timestamptz := now();
BEGIN
  IF p_member_id IS NULL THEN
    RETURN jsonb_build_object('promoted', false, 'reason', 'invalid');
  END IF;

  -- (0) Serialize on the member before reading any count.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_member_id::text, 0));

  SELECT count(*) INTO v_n_active FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'active';
  SELECT count(*) INTO v_n_queued FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'queued';
  IF v_n_active > 1 OR v_n_queued > 1 THEN
    RETURN jsonb_build_object('promoted', false, 'reason', 'inconsistent_batches');
  END IF;

  SELECT * INTO v_active FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'active' FOR UPDATE;

  IF v_active.batch_id IS NOT NULL THEN
    -- UNRESOLVED, SCOPED TO THIS BATCH: one of ITS 'suggested' rows whose requester has not
    -- expressed interest in that target. Rows outside the batch — reciprocal cards above all — are
    -- not this batch's business and never block its completion.
    SELECT count(*) INTO v_unresolved
    FROM public.intro_requests s
    WHERE s.requester_id = p_member_id
      AND s.batch_id = v_active.batch_id
      AND s.status = 'suggested'
      AND NOT EXISTS (
        SELECT 1 FROM public.intro_requests e
        WHERE e.requester_id = p_member_id
          AND e.target_user_id = s.target_user_id
          AND e.status IN ('pending','accepted','accepted_pending_payment','admin_pending','approved')
      );
    IF v_unresolved > 0 THEN
      RETURN jsonb_build_object('promoted', false, 'reason', 'incomplete');
    END IF;

    -- Complete it: archive the lingering 'suggested' rows OF THIS BATCH (they were resolved by
    -- expressed interest, which lives on its own pending/approved row, so nothing is hidden).
    -- Scoped by batch_id, so a pair-governed reciprocal card is never archived here — archiving one
    -- side of a pair would orphan the other.
    UPDATE public.intro_requests SET status = 'archived', updated_at = v_now
      WHERE requester_id = p_member_id AND batch_id = v_active.batch_id AND status = 'suggested';
    UPDATE public.recommendation_batches SET state = 'completed', completed_at = v_now
      WHERE batch_id = v_active.batch_id;
    v_completed := v_active.batch_id;
  END IF;

  SELECT * INTO v_queued FROM public.recommendation_batches b
    WHERE b.member_id = p_member_id AND b.state = 'queued' FOR UPDATE;
  IF v_queued.batch_id IS NULL THEN
    RETURN jsonb_build_object('promoted', false, 'active_completed', v_completed,
      'reason', CASE WHEN v_completed IS NULL THEN 'no_active' ELSE 'empty_queue' END);
  END IF;

  -- (0b) RESPONSE ELIGIBILITY (migration 081). Revealing a QUEUED batch is a later release, so it
  --      requires the member to be genuinely clear. The batch-scoped check above only asked whether
  --      THIS batch was finished; a reciprocal card sitting outside it was explicitly "not this
  --      batch's business" and so could not block the reveal. That was the bypass: a member could be
  --      shown a fresh queued batch while still owing a response on an unrelated card. No exclusion
  --      is passed — nothing in the queued batch is visible yet, so nothing in it can be prior work.
  IF public.count_unresolved_introductions(p_member_id, NULL, NULL) > 0 THEN
    RETURN jsonb_build_object('promoted', false, 'active_completed', v_completed,
      'reason', 'unresolved');
  END IF;

  -- (1) Re-count VISIBLE after completion. Pair-governed reciprocal cards survive it and count.
  -- (085) USABLE visible capacity — see count_usable_visible_cards. Read-only.
  v_visible := public.count_usable_visible_cards(p_member_id);
  v_free := c_max_visible - v_visible;
  IF v_free <= 0 THEN
    -- Nothing is revealed and nothing is discarded: the reservation waits, and a later call (after
    -- the member resolves a visible card) promotes it. The member is never shown more than the cap.
    RETURN jsonb_build_object('promoted', false, 'active_completed', v_completed,
      'reason', 'deferred_capacity');
  END IF;

  -- (2) Reveal only what fits, oldest-first so the reservation that has waited longest is shown.
  UPDATE public.intro_requests SET status = 'suggested', updated_at = v_now
  WHERE id IN (
    SELECT ir.id FROM public.intro_requests ir
    WHERE ir.requester_id = p_member_id AND ir.batch_id = v_queued.batch_id AND ir.status = 'queued'
    ORDER BY ir.created_at, ir.id
    LIMIT v_free
  );
  GET DIAGNOSTICS v_promoted = ROW_COUNT;

  IF v_promoted = 0 THEN
    -- A queued batch with no queued rows is inconsistent metadata, not a promotion. Close it out
    -- rather than flipping an empty batch to active and reporting a reveal that showed nothing.
    UPDATE public.recommendation_batches SET state = 'completed', completed_at = v_now
      WHERE batch_id = v_queued.batch_id;
    RETURN jsonb_build_object('promoted', false, 'active_completed', v_completed,
      'reason', 'empty_queued_batch');
  END IF;

  -- (3) Flip the batch to ACTIVE first (no other active batch exists at this point) ...
  UPDATE public.recommendation_batches SET state = 'active', displayed_at = v_now
    WHERE batch_id = v_queued.batch_id;

  -- (4) ... then move any un-promoted rows into a NEW queued batch, so every batch's rows share its
  --     state. Done in this order because the one-queued-per-member index would reject an overlap.
  SELECT count(*) INTO v_leftover FROM public.intro_requests ir
    WHERE ir.requester_id = p_member_id AND ir.batch_id = v_queued.batch_id AND ir.status = 'queued';

  IF v_leftover > 0 THEN
    v_split := gen_random_uuid();
    INSERT INTO public.recommendation_batches
      (batch_id, member_id, batch_source, state, reciprocal_batch_id,
       created_at, generated_at, displayed_at, completed_at)
    VALUES
      (v_split, p_member_id, v_queued.batch_source, 'queued', v_queued.reciprocal_batch_id,
       v_queued.created_at, v_queued.generated_at, NULL, NULL);
    UPDATE public.intro_requests SET batch_id = v_split, updated_at = v_now
      WHERE requester_id = p_member_id AND batch_id = v_queued.batch_id AND status = 'queued';
  END IF;

  RETURN jsonb_build_object(
    'promoted', true,
    'active_completed', v_completed,
    'new_active', v_queued.batch_id,
    'split_batch', v_split,
    'count', v_promoted);
END;
$$;

CREATE OR REPLACE FUNCTION public.materialize_admin_pair(
  p_review_batch_id uuid,
  p_member_a        uuid,
  p_member_b        uuid,
  p_batch_a         uuid    DEFAULT NULL,   -- optional: member A's recommendation_batches.batch_id
  p_batch_b         uuid    DEFAULT NULL,   -- optional: member B's recommendation_batches.batch_id
  p_cooldown_days   integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  c_max_visible  constant integer := 2;   -- identical to migration 063; no argument can raise it
  c_max_reserved constant integer := 2;
  c_source       constant text    := 'admin_reciprocal';

  lo uuid; hi uuid;                        -- canonical pair order
  v_now      timestamptz := pg_catalog.now();
  v_cutoff   timestamptz := pg_catalog.now()
                            - pg_catalog.make_interval(days => GREATEST(COALESCE(p_cooldown_days, 30), 0));
  v_batch          record;
  v_prop_lo        record;                 -- review row: recipient = lo, suggested = hi
  v_prop_hi        record;                 -- review row: recipient = hi, suggested = lo
  v_n_lo   integer; v_n_hi integer;        -- approvable proposals per direction (must be exactly 1)
  v_m_lo   integer; v_m_hi integer;        -- already-materialised proposals per direction
  v_live_n integer; v_live_lo integer; v_live_hi integer;
  v_live_pairs integer; v_live_nullpair integer; v_live_badstatus integer;
  v_live_pair_id uuid; v_bad_batch integer;
  v_pair   record;                         -- existing canonical member_pairs row, READ not created
  v_vis_lo integer; v_res_lo integer;
  v_vis_hi integer; v_res_hi integer;
  v_tier   text;
  v_state  text;
  v_pair_id uuid;
  v_batch_lo uuid; v_batch_hi uuid;
  v_bat_lo   record; v_bat_hi record;      -- the member's existing envelope in the target tier
  v_stale_lo boolean; v_stale_hi boolean;  -- envelope holds no live suggested/queued row
  v_retire_lo boolean; v_retire_hi boolean;
  v_comp_lo text; v_comp_hi text;
BEGIN
  ---------------------------------------------------------------- (1) shape of the request
  IF p_review_batch_id IS NULL OR p_member_a IS NULL OR p_member_b IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','missing_argument');
  END IF;
  IF p_member_a = p_member_b THEN
    -- No unique index or CHECK prevents a self-row; this is the only thing that does.
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','self_pair');
  END IF;

  ---------------------------------------------------------------- (2) canonicalise
  lo := LEAST(p_member_a, p_member_b);
  hi := GREATEST(p_member_a, p_member_b);

  ---------------------------------------------------------------- (3) participant advisory locks
  -- Canonical order, so two concurrent approvals sharing a member can never deadlock. Same key
  -- space as migrations 050/063, so this serialises against place_batch_rows,
  -- create_reciprocal_suggestion and promote_queued_rows for the same member.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  ---------------------------------------------------------------- (4) review batch + both proposals
  SELECT ib.id, ib.status INTO v_batch
  FROM public.introduction_batches ib
  WHERE ib.id = p_review_batch_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','review_batch_not_found');
  END IF;
  IF v_batch.status IS DISTINCT FROM 'pending_review' AND v_batch.status IS DISTINCT FROM 'active' THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','review_batch_not_approvable');
  END IF;

  -- ── PROPOSAL CENSUS ────────────────────────────────────────────────────────────────────────────
  -- EXACTLY ONE approvable row is required in EACH direction. Production has no unique constraint
  -- on batch_suggestions(batch_id, recipient_id, suggested_id), so duplicates are physically
  -- possible; picking one with LIMIT 1 would make the outcome depend on an arbitrary row order and
  -- could materialise against a row the reviewer never saw. Count first; never pick.
  SELECT count(*) INTO v_n_lo FROM public.batch_suggestions bs
  WHERE bs.batch_id = p_review_batch_id AND bs.recipient_id = lo AND bs.suggested_id = hi
    AND bs.status = 'generated' AND bs.materialized_at IS NULL;
  SELECT count(*) INTO v_n_hi FROM public.batch_suggestions bs
  WHERE bs.batch_id = p_review_batch_id AND bs.recipient_id = hi AND bs.suggested_id = lo
    AND bs.status = 'generated' AND bs.materialized_at IS NULL;
  SELECT count(*) INTO v_m_lo FROM public.batch_suggestions bs
  WHERE bs.batch_id = p_review_batch_id AND bs.recipient_id = lo AND bs.suggested_id = hi
    AND bs.materialized_at IS NOT NULL;
  SELECT count(*) INTO v_m_hi FROM public.batch_suggestions bs
  WHERE bs.batch_id = p_review_batch_id AND bs.recipient_id = hi AND bs.suggested_id = lo
    AND bs.materialized_at IS NOT NULL;

  ---------------------------------------------------------------- (5) REPLAY, with exact symmetry
  IF v_m_lo > 0 OR v_m_hi > 0 THEN
    -- Something in this pair was already materialised. It is a valid replay ONLY if the world is
    -- exactly as one successful call leaves it. Every clause below is required.
    IF v_m_lo <> 1 OR v_m_hi <> 1 OR v_n_lo <> 0 OR v_n_hi <> 0 THEN
      RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','materialized_state_inconsistent');
    END IF;

    SELECT mp.id INTO v_pair_id
    FROM public.member_pairs mp WHERE mp.user_a_id = lo AND mp.user_b_id = hi;

    SELECT count(*),
           count(*) FILTER (WHERE ir.requester_id = lo AND ir.target_user_id = hi),
           count(*) FILTER (WHERE ir.requester_id = hi AND ir.target_user_id = lo),
           count(DISTINCT ir.pair_id),
           count(*) FILTER (WHERE ir.pair_id IS NULL),
           count(*) FILTER (WHERE ir.status <> 'suggested'),
           -- min(uuid) is NOT a PostgreSQL aggregate; compare as text and cast back. The
           -- count(DISTINCT ...) above already proves there is exactly one value to pick.
           min(ir.pair_id::text)::uuid
      INTO v_live_n, v_live_lo, v_live_hi, v_live_pairs, v_live_nullpair, v_live_badstatus, v_live_pair_id
    FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND ir.status IN ('suggested','queued');

    IF v_live_n <> 2 OR v_live_lo <> 1 OR v_live_hi <> 1
       OR v_live_pairs <> 1 OR v_live_nullpair <> 0 OR v_live_badstatus <> 0
       OR v_live_pair_id IS NULL
       OR v_pair_id IS NULL OR v_live_pair_id IS DISTINCT FROM v_pair_id THEN
      RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','materialized_state_inconsistent');
    END IF;

    -- Each live row must sit in ITS OWN member's ACTIVE admin envelope.
    --
    -- Deliberately NOT `b.reciprocal_batch_id = p_review_batch_id`. That would contradict the
    -- envelope model: a live admin envelope created by review X is legitimately REUSED when review
    -- Y appends a second card, and its reciprocal_batch_id correctly stays X. Requiring Y here made
    -- every retry of that approval report materialized_state_inconsistent for a perfectly healthy
    -- pair. Envelope ownership, state and source are what a card's placement must satisfy; the
    -- CURRENT REVIEW's provenance is proven separately, by v_m_lo = 1 and v_m_hi = 1 above — the two
    -- symmetric batch_suggestions rows under p_review_batch_id, each materialised exactly once.
    SELECT count(*) INTO v_bad_batch
    FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND ir.status = 'suggested'
      AND NOT EXISTS (
        SELECT 1 FROM public.recommendation_batches b
        WHERE b.batch_id = ir.batch_id
          AND b.member_id = ir.requester_id          -- the envelope belongs to the card's owner
          AND b.state = 'active'                      -- and is the member's live envelope
          AND b.batch_source = c_source);             -- and was produced by the admin path
    IF v_bad_batch <> 0 THEN
      RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','materialized_state_inconsistent');
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'outcome','already_materialized','pair_id', v_pair_id, 'review_batch_id', p_review_batch_id);
  END IF;

  ---------------------------------------------------------------- (6) exactly one approvable each
  IF v_n_lo > 1 OR v_n_hi > 1 THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','duplicate_proposal');
  END IF;
  IF v_n_lo <> 1 OR v_n_hi <> 1 THEN
    -- Missing, dropped, passed, hidden, or already shown on one side. Never materialise one-sidedly.
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','proposal_not_symmetric');
  END IF;

  SELECT bs.id, bs.match_score, bs.reason INTO v_prop_lo
  FROM public.batch_suggestions bs
  WHERE bs.batch_id = p_review_batch_id AND bs.recipient_id = lo AND bs.suggested_id = hi
    AND bs.status = 'generated' AND bs.materialized_at IS NULL
  FOR UPDATE;
  SELECT bs.id, bs.match_score, bs.reason INTO v_prop_hi
  FROM public.batch_suggestions bs
  WHERE bs.batch_id = p_review_batch_id AND bs.recipient_id = hi AND bs.suggested_id = lo
    AND bs.status = 'generated' AND bs.materialized_at IS NULL
  FOR UPDATE;

  ---------------------------------------------------------------- (7) both members still eligible
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = lo AND p.account_status = 'active' AND p.profile_complete = true
      AND COALESCE(p.is_test_account,false) = false AND COALESCE(p.is_admin,false) = false
      AND COALESCE(p.matching_paused,false) = false
  ) OR NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = hi AND p.account_status = 'active' AND p.profile_complete = true
      AND COALESCE(p.is_test_account,false) = false AND COALESCE(p.is_admin,false) = false
      AND COALESCE(p.matching_paused,false) = false
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','ineligible');
  END IF;

  ---------------------------------------------------------------- (8) blocking, both directions
  IF EXISTS (
    SELECT 1 FROM public.blocked_users bu
    WHERE (bu.user_id = lo AND bu.blocked_user_id = hi)
       OR (bu.user_id = hi AND bu.blocked_user_id = lo)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','blocked');
  END IF;

  ---------------------------------------------------------------- (9) already connected
  IF EXISTS (
    SELECT 1 FROM public.matches m
    WHERE (m.user_a_id = lo AND m.user_b_id = hi)
       OR (m.user_a_id = hi AND m.user_b_id = lo)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','already_matched');
  END IF;

  ---------------------------------------------------------------- (10) live rows / hard history
  -- Pure existence probes (no row is selected), so no LIMIT appears anywhere in this function.
  IF EXISTS (
    SELECT 1 FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND ir.status IN ('suggested','queued','pending','accepted',
                        'accepted_pending_payment','admin_pending','approved')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','exists_active');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND ir.status IN ('declined','rejected','hidden','hidden_permanent')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','history');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.intro_requests ir
    WHERE ((ir.requester_id = lo AND ir.target_user_id = hi)
        OR (ir.requester_id = hi AND ir.target_user_id = lo))
      AND ir.status IN ('passed','expired') AND ir.updated_at >= v_cutoff
  ) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','cooldown');
  END IF;

  ---------------------------------------------------------------- (11) normalised same-company
  -- Mirrors lib/matching/same-company.ts: lowercase, trim, strip common corporate suffixes; an
  -- empty company on either side is permissive (not same-company). Enforced HERE as well as at
  -- generation, because a member can change employer between review and approval.
  SELECT lower(btrim(regexp_replace(COALESCE(p.company,''),
           '[,.]?\s*(llc|inc|corp|ltd|p\.c\.|llp|s\.a\.|gmbh|ag|limited|incorporated|corporation|company)\.?\s*$',
           '', 'i')))
    INTO v_comp_lo FROM public.profiles p WHERE p.id = lo;
  SELECT lower(btrim(regexp_replace(COALESCE(p.company,''),
           '[,.]?\s*(llc|inc|corp|ltd|p\.c\.|llp|s\.a\.|gmbh|ag|limited|incorporated|corporation|company)\.?\s*$',
           '', 'i')))
    INTO v_comp_hi FROM public.profiles p WHERE p.id = hi;
  IF v_comp_lo <> '' AND v_comp_lo = v_comp_hi THEN
    RETURN pg_catalog.jsonb_build_object('outcome','same_company');
  END IF;

  ---------------------------------------------------------------- (12) capacity for BOTH members
  -- Reserved counts are read too, but only to report why a refusal happened. They can never make a
  -- pair placeable: see the VISIBLE TIER ONLY note in the header.
  -- (085) USABLE visible capacity for both members — see count_usable_visible_cards. Read-only;
  -- the reserved tier is counted exactly as before and still cannot make a pair placeable.
  SELECT count(*) FILTER (WHERE ir.status = 'queued') INTO v_res_lo
  FROM public.intro_requests ir WHERE ir.requester_id = lo;
  SELECT count(*) FILTER (WHERE ir.status = 'queued') INTO v_res_hi
  FROM public.intro_requests ir WHERE ir.requester_id = hi;
  v_vis_lo := public.count_usable_visible_cards(lo);
  v_vis_hi := public.count_usable_visible_cards(hi);

  ---------------------------------------------------------------- (12b) RESPONSE ELIGIBILITY (081)
  -- An admin pair is a NEW release for both members, so neither gets an envelope exclusion. It
  -- refuses BEFORE any write, so a refusal can never leave one member holding a card the other does
  -- not have — the asymmetry this whole function exists to prevent.
  IF public.count_unresolved_introductions(lo, NULL, NULL) > 0
     OR public.count_unresolved_introductions(hi, NULL, NULL) > 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome','unresolved',
      'unresolved_lo', public.count_unresolved_introductions(lo, NULL, NULL),
      'unresolved_hi', public.count_unresolved_introductions(hi, NULL, NULL));
  END IF;

  ---------------------------------------------------------------- (13) the ONE placeable tier
  -- Capacity alone decides the tier here. Envelope usability is a SEPARATE question, settled in
  -- step (15) where a stale envelope can be retired rather than blocking the member.
  IF v_vis_lo < c_max_visible AND v_vis_hi < c_max_visible THEN
    v_tier := 'suggested'; v_state := 'active';
  ELSE
    RETURN pg_catalog.jsonb_build_object(
      'outcome','capacity',
      'visible_free_lo', GREATEST(0, c_max_visible  - v_vis_lo),
      'visible_free_hi', GREATEST(0, c_max_visible  - v_vis_hi),
      'reserved_free_lo',GREATEST(0, c_max_reserved - v_res_lo),
      'reserved_free_hi',GREATEST(0, c_max_reserved - v_res_hi));
  END IF;

  ---------------------------------------------------------------- (14) member_pairs: READ, not create
  -- Deliberately a plain SELECT. Creating the row here and refusing below would leave it behind,
  -- because RETURN does not roll back. The row is created only in the write phase.
  SELECT mp.id, mp.status, mp.last_recommended_at INTO v_pair
  FROM public.member_pairs mp
  WHERE mp.user_a_id = lo AND mp.user_b_id = hi
  FOR UPDATE;

  IF FOUND THEN
    -- Status policy (see the header). Terminal statuses are never reactivated.
    IF v_pair.status = 'matched' THEN
      RETURN pg_catalog.jsonb_build_object('outcome','already_matched','detail','pair_status_matched');
    ELSIF v_pair.status = 'blocked' THEN
      RETURN pg_catalog.jsonb_build_object('outcome','blocked','detail','pair_status_blocked');
    ELSIF v_pair.status = 'ineligible' THEN
      RETURN pg_catalog.jsonb_build_object('outcome','ineligible','detail','pair_status_ineligible');
    ELSIF v_pair.status = 'superseded' THEN
      RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','pair_status_superseded');
    ELSIF v_pair.status NOT IN ('active','passed','expired') THEN
      RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','pair_status_unknown');
    END IF;

    IF v_pair.last_recommended_at IS NOT NULL AND v_pair.last_recommended_at >= v_cutoff THEN
      RETURN pg_catalog.jsonb_build_object('outcome','cooldown','detail','pair_cooldown');
    END IF;
  END IF;

  ---------------------------------------------------------------- (15) envelopes: READ + decide
  -- Unique-key reads (one active row per member, by partial unique index). No ordering, no LIMIT.
  SELECT b.batch_id, b.batch_source, b.reciprocal_batch_id INTO v_bat_lo
  FROM public.recommendation_batches b
  WHERE b.member_id = lo AND b.state = v_state
  FOR UPDATE;
  SELECT b.batch_id, b.batch_source, b.reciprocal_batch_id INTO v_bat_hi
  FROM public.recommendation_batches b
  WHERE b.member_id = hi AND b.state = v_state
  FOR UPDATE;

  -- Is the envelope STALE — i.e. does it still hold anything the member can see or is waiting on?
  -- Only a stale envelope may be retired, and retiring one can never hide a card.
  v_stale_lo := FALSE; v_stale_hi := FALSE;
  IF v_bat_lo.batch_id IS NOT NULL THEN
    SELECT NOT EXISTS (SELECT 1 FROM public.intro_requests ir
                       WHERE ir.batch_id = v_bat_lo.batch_id AND ir.status IN ('suggested','queued'))
      INTO v_stale_lo;
  END IF;
  IF v_bat_hi.batch_id IS NOT NULL THEN
    SELECT NOT EXISTS (SELECT 1 FROM public.intro_requests ir
                       WHERE ir.batch_id = v_bat_hi.batch_id AND ir.status IN ('suggested','queued'))
      INTO v_stale_hi;
  END IF;

  -- A LIVE envelope from another producer cannot take an admin card: appending would make
  -- batch_source a lie, and retiring it would hide cards the member can currently see.
  IF (v_bat_lo.batch_id IS NOT NULL AND NOT v_stale_lo AND v_bat_lo.batch_source IS DISTINCT FROM c_source)
     OR (v_bat_hi.batch_id IS NOT NULL AND NOT v_stale_hi AND v_bat_hi.batch_source IS DISTINCT FROM c_source) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','capacity','detail','active_batch_source_conflict');
  END IF;

  -- Reuse only a LIVE admin envelope. A stale one (any source) is retired in the write phase, and a
  -- fresh envelope is created stamped with THIS review batch. reciprocal_batch_id is never rewritten.
  v_batch_lo := CASE WHEN v_bat_lo.batch_id IS NOT NULL AND NOT v_stale_lo THEN v_bat_lo.batch_id END;
  v_batch_hi := CASE WHEN v_bat_hi.batch_id IS NOT NULL AND NOT v_stale_hi THEN v_bat_hi.batch_id END;
  v_retire_lo := (v_bat_lo.batch_id IS NOT NULL AND v_stale_lo);
  v_retire_hi := (v_bat_hi.batch_id IS NOT NULL AND v_stale_hi);

  -- p_batch_a belongs to p_member_a, which may be either side of canonical order — map it, never
  -- assume. An id supplied for a member whose envelope will be newly created is a mismatch: the
  -- caller cannot have known an id that does not exist yet.
  IF (p_batch_a IS NOT NULL AND p_batch_a IS DISTINCT FROM
        (CASE WHEN p_member_a = lo THEN v_batch_lo ELSE v_batch_hi END))
     OR (p_batch_b IS NOT NULL AND p_batch_b IS DISTINCT FROM
        (CASE WHEN p_member_b = lo THEN v_batch_lo ELSE v_batch_hi END)) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','batch_id_mismatch');
  END IF;

  ---------------------------------------------------------------- (16) ════ FIRST WRITE ════
  -- Everything above this line is READ-ONLY. Every refusal returns with the database untouched.
  INSERT INTO public.member_pairs (user_a_id, user_b_id, source)
  VALUES (lo, hi, 'admin')
  ON CONFLICT (user_a_id, user_b_id) DO NOTHING;

  SELECT mp.id INTO v_pair_id
  FROM public.member_pairs mp
  WHERE mp.user_a_id = lo AND mp.user_b_id = hi
  FOR UPDATE;

  -- Retire a stale envelope FIRST: the one-active-per-member partial unique index would reject an
  -- overlap. This is the same transition promote_queued_rows makes, and it hides nothing, because
  -- step (15) proved the envelope holds no live row.
  IF v_retire_lo THEN
    UPDATE public.recommendation_batches
    SET state = 'completed', completed_at = v_now
    WHERE batch_id = v_bat_lo.batch_id;
  END IF;
  IF v_retire_hi THEN
    UPDATE public.recommendation_batches
    SET state = 'completed', completed_at = v_now
    WHERE batch_id = v_bat_hi.batch_id;
  END IF;

  IF v_batch_lo IS NULL THEN
    v_batch_lo := pg_catalog.gen_random_uuid();
    INSERT INTO public.recommendation_batches
      (batch_id, member_id, batch_source, state, reciprocal_batch_id,
       created_at, generated_at, displayed_at, completed_at)
    VALUES (v_batch_lo, lo, c_source, v_state, p_review_batch_id, v_now, v_now, v_now, NULL);
  END IF;
  IF v_batch_hi IS NULL THEN
    v_batch_hi := pg_catalog.gen_random_uuid();
    INSERT INTO public.recommendation_batches
      (batch_id, member_id, batch_source, state, reciprocal_batch_id,
       created_at, generated_at, displayed_at, completed_at)
    VALUES (v_batch_hi, hi, c_source, v_state, p_review_batch_id, v_now, v_now, v_now, NULL);
  END IF;

  -- Each side carries its OWN member-level batch_id. Same status, same pair_id, same transaction:
  -- one direction cannot exist without the other.
  INSERT INTO public.intro_requests
    (requester_id, target_user_id, status, is_admin_initiated, match_reason,
     match_score, pair_id, batch_id, created_at, updated_at)
  VALUES
    (lo, hi, v_tier, true, v_prop_lo.reason,
     COALESCE(pg_catalog.round(v_prop_lo.match_score)::integer, 0), v_pair_id, v_batch_lo, v_now, v_now),
    (hi, lo, v_tier, true, v_prop_hi.reason,
     COALESCE(pg_catalog.round(v_prop_hi.match_score)::integer, 0), v_pair_id, v_batch_hi, v_now, v_now);

  UPDATE public.member_pairs
  SET recommend_count      = recommend_count + 1,
      last_recommended_at  = v_now,
      first_recommended_at = COALESCE(first_recommended_at, v_now),
      status               = 'active'
  WHERE id = v_pair_id;

  -- Only now, and only for a pair that actually landed. A rejected pair returned above with its
  -- review rows still 'generated', so it stays visible and re-approvable.
  UPDATE public.batch_suggestions
  SET status = 'shown', shown_at = COALESCE(shown_at, v_now), materialized_at = v_now
  WHERE id IN (v_prop_lo.id, v_prop_hi.id);

  ---------------------------------------------------------------- (18) structured result
  RETURN pg_catalog.jsonb_build_object(
    'outcome','created',
    'tier', v_tier,
    'pair_id', v_pair_id,
    'review_batch_id', p_review_batch_id,
    'batch_id_lo', v_batch_lo,
    'batch_id_hi', v_batch_hi);
END;
$$;

-- ── 9. POSTCONDITIONS — same transaction, so a failure rolls everything back ──────────────────
DO $verify$
DECLARE
  v_src text;
  v_rec record;
BEGIN
  SELECT prosrc INTO v_src FROM pg_catalog.pg_proc
   WHERE oid = pg_catalog.to_regprocedure('public.count_unresolved_introductions(uuid, uuid, uuid)');
  IF v_src IS NULL OR pg_catalog.strpos(v_src, 'is_available_intro_target') = 0
     OR pg_catalog.strpos(v_src, 'responds_to_id IS NULL') = 0 THEN
    RAISE EXCEPTION 'MIGRATION 085: the corrected unresolved gate did not install.';
  END IF;

  FOR v_rec IN SELECT * FROM (VALUES
      ('public.is_available_intro_target(uuid, uuid)'),
      ('public.count_usable_visible_cards(uuid)'),
      ('public.neutralize_unavailable_pair(uuid)'),
      ('public.sweep_unavailable_introductions(integer)')) AS t(sig)
  LOOP
    IF pg_catalog.to_regprocedure(v_rec.sig) IS NULL THEN
      RAISE EXCEPTION 'MIGRATION 085: % did not install.', v_rec.sig;
    END IF;
  END LOOP;

  -- NO LOCK-BYPASS SIGNATURE MAY EXIST, under any name or arity.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('release_unavailable_introduction','reconcile_unavailable_introductions')) THEN
    RAISE EXCEPTION
      'MIGRATION 085: a lock-bypassing neutraliser is deployed. There must be exactly one locked '
      'entry point (neutralize_unavailable_pair) and no bypass argument.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'neutralize_unavailable_pair'
                AND p.pronargs <> 1) THEN
    RAISE EXCEPTION 'MIGRATION 085: neutralize_unavailable_pair has an overload; exactly one 1-argument signature is permitted.';
  END IF;

  -- Every writer must compute USABLE capacity, and none may still count raw suggested rows.
  FOR v_rec IN
    SELECT p.proname, p.prosrc FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN
       ('create_reciprocal_suggestion','place_batch_rows','promote_queued_rows','materialize_admin_pair')
  LOOP
    IF pg_catalog.strpos(v_rec.prosrc, 'count_usable_visible_cards') = 0 THEN
      RAISE EXCEPTION
        'MIGRATION 085: public.% does not use count_usable_visible_cards — a stale unavailable card '
        'would still consume that member''s visible capacity.', v_rec.proname;
    END IF;
    IF pg_catalog.strpos(v_rec.prosrc, 'status = ''suggested'' AND ir.capacity_released_at IS NULL') > 0 THEN
      RAISE EXCEPTION
        'MIGRATION 085: public.% still counts RAW suggested rows for capacity.', v_rec.proname;
    END IF;
    -- A writer must never physically neutralise: that is the maintenance authority's job.
    IF pg_catalog.strpos(v_rec.prosrc, 'neutralize_unavailable_pair') > 0 THEN
      RAISE EXCEPTION
        'MIGRATION 085: public.% calls the neutraliser. Writers are read-only with respect to '
        'unavailable rows.', v_rec.proname;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege('anon','public.count_unresolved_introductions(uuid, uuid, uuid)','EXECUTE')
   OR pg_catalog.has_function_privilege('authenticated','public.count_unresolved_introductions(uuid, uuid, uuid)','EXECUTE')
   OR pg_catalog.has_function_privilege('anon','public.neutralize_unavailable_pair(uuid)','EXECUTE')
   OR pg_catalog.has_function_privilege('authenticated','public.neutralize_unavailable_pair(uuid)','EXECUTE')
   OR pg_catalog.has_function_privilege('anon','public.sweep_unavailable_introductions(integer)','EXECUTE')
   OR pg_catalog.has_function_privilege('authenticated','public.sweep_unavailable_introductions(integer)','EXECUTE')
   OR pg_catalog.has_function_privilege('anon','public.count_usable_visible_cards(uuid)','EXECUTE')
   OR pg_catalog.has_function_privilege('authenticated','public.count_usable_visible_cards(uuid)','EXECUTE')
   OR pg_catalog.has_function_privilege('anon','public.is_available_intro_target(uuid, uuid)','EXECUTE')
   OR pg_catalog.has_function_privilege('authenticated','public.is_available_intro_target(uuid, uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'MIGRATION 085: a browser role can EXECUTE one of these functions.';
  END IF;
  IF NOT pg_catalog.has_function_privilege('service_role','public.count_unresolved_introductions(uuid, uuid, uuid)','EXECUTE')
   OR NOT pg_catalog.has_function_privilege('service_role','public.neutralize_unavailable_pair(uuid)','EXECUTE')
   OR NOT pg_catalog.has_function_privilege('service_role','public.sweep_unavailable_introductions(integer)','EXECUTE')
   OR NOT pg_catalog.has_function_privilege('service_role','public.count_usable_visible_cards(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'MIGRATION 085: service_role cannot EXECUTE one of these functions.';
  END IF;

  -- The neutral reason is accepted and the member vocabulary is unchanged.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conname = 'intro_requests_resolution_reason_check'
       AND conrelid = 'public.intro_requests'::pg_catalog.regclass
       AND pg_catalog.pg_get_constraintdef(oid) LIKE '%system_pair_unavailable%'
       AND pg_catalog.pg_get_constraintdef(oid) LIKE '%not_for_me%'
       AND pg_catalog.pg_get_constraintdef(oid) LIKE '%never_show%'
       AND pg_catalog.pg_get_constraintdef(oid) LIKE '%already_know%'
  ) THEN
    RAISE EXCEPTION 'MIGRATION 085: the resolution_reason constraint is not the expected one.';
  END IF;

  -- NO BACKFILL: this migration rewrites nothing.
  IF EXISTS (SELECT 1 FROM public.intro_requests WHERE resolution_reason = 'system_pair_unavailable') THEN
    RAISE EXCEPTION
      'MIGRATION 085: rows already carry the system reason. This migration writes no row; '
      'historical cleanup is a separate, gated artifact.';
  END IF;

  RAISE NOTICE '085 OK — availability/gate/usable-capacity + locked neutraliser + sweep installed, '
    '4 writers use usable capacity, no lock-bypass signature, 0 rows rewritten.';
END
$verify$;

COMMIT;
