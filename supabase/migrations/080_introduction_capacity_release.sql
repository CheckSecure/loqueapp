-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 080 — INTRODUCTION CAPACITY RELEASE
--
-- THE DEFECT. lib/introRequests/index.ts inserts a NEW 'pending' row when a member expresses
-- interest and LEAVES the original 'suggested' row in place. Every capacity counter in migration
-- 063 counts status = 'suggested', so a card the feed has already hidden still occupies its
-- author's visible capacity — for up to 14 days, until expire_intro_pair closes the pair. A member
-- who acted on both of their cards receives nothing new for a fortnight.
--
-- THE FIX, in one sentence: a hidden card stops counting against ITS OWN AUTHOR 72 hours after that
-- author expressed interest. Nothing else changes.
--
-- ─── DIRECTIONAL, AND ONLY DIRECTIONAL ────────────────────────────────────────────────────────
-- A→B and B→A are two independent rows and are treated as such:
--   A→B 'suggested', A has expressed interest → hidden by the feed → RELEASE CANDIDATE after 72h.
--   B→A 'suggested', B silent                → VISIBLE AND ACTIONABLE → NEVER released. B still has
--                                              to see it and answer it, so it must keep consuming
--                                              B's capacity until B acts, the pair expires, or B
--                                              becomes ineligible.
-- Releasing B's row because A acted would either hide a card B never answered or let B accumulate
-- three visible cards. The release predicate is keyed on the row's own requester for that reason.
--
-- ─── WHY A CORRELATION COLUMN WAS UNAVOIDABLE ─────────────────────────────────────────────────
-- Before this migration an expression of interest carried NO pair_id and NO batch_id, so nothing
-- linked it to the recommendation it answered. Worse, the idempotency path selected existing
-- pending/approved rows ORDER BY created_at ASC and reused the OLDEST — so after a cooldown
-- re-recommendation, a stale expression from a previous epoch was reused and its created_at was the
-- old date. Any timestamp-only correlation is therefore inference, not evidence, and would release a
-- NEW card on the strength of an OLD expression.
--
-- responds_to_id makes the correlation an identity match: the expression points at the exact
-- suggested row it answered. No older expression can release a later re-recommendation, because it
-- points at a different row id.
--
-- ─── NO BACKFILL ──────────────────────────────────────────────────────────────────────────────
-- responds_to_id is NULL on every existing row and is never inferred. A row with no correlation is
-- simply not a release candidate; it drains through the existing 14-day expiry exactly as today.
-- Inferring a correlation from timestamps is precisely the mistake the column exists to prevent.
--
-- ─── MIGRATIONS 063-079 ARE NOT EDITED ────────────────────────────────────────────────────────
-- The four capacity writers are replaced HERE with CREATE OR REPLACE, bodies transcribed from the
-- committed 063/064 files with exactly six surgical edits (below). Every signature, return
-- contract, advisory lock, cap constant, eligibility gate, error string, search_path and schema
-- qualification is preserved byte-for-byte apart from those six.
--
-- THE SIX EDITS, and only these six:
--   create_reciprocal_suggestion  2x  visible-capacity count for each member
--   place_batch_rows              1x  visible FILTER in the capacity count
--   promote_queued_rows           1x  visible re-count after batch completion
--   materialize_admin_pair        2x  visible FILTER for lo and hi
-- Each adds `AND capacity_released_at IS NULL` to a COUNT. Deliberately NOT changed:
--   * promote_queued_rows' batch-completion "unresolved" count — a released row IS resolved (that
--     is why it was released), and the existing NOT EXISTS already excludes it;
--   * promote_queued_rows' archive UPDATE — released rows must still be archived with their batch;
--   * promote_queued_rows' promotion UPDATE — it writes status, it does not count;
--   * materialize_admin_pair's v_bad_batch provenance check — it is a provenance test, not capacity.
--
-- ─── expire_intro_pair IS DELIBERATELY UNCHANGED ──────────────────────────────────────────────
-- Audited and left alone. It counts 'suggested' rows to decide whether a pair is closable, NOT to
-- decide capacity. A released row must still be closed by expiry — it is still a live row on a live
-- pair — so excluding it there would strand exactly the rows this migration creates. Its 14-day
-- window and its 'protected'/mutual_pending behaviour are untouched, which is what keeps delayed
-- mutual completion working after a release.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. COLUMNS ────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.intro_requests
  ADD COLUMN IF NOT EXISTS responds_to_id       uuid        NULL,
  ADD COLUMN IF NOT EXISTS capacity_released_at timestamptz NULL;

COMMENT ON COLUMN public.intro_requests.responds_to_id IS
  'The exact ''suggested'' row this expression of interest answers. NULL on every pre-080 row and '
  'never inferred. Identity correlation, so a stale expression from an earlier recommendation epoch '
  'can never release a later re-recommendation. See migration 080.';
COMMENT ON COLUMN public.intro_requests.capacity_released_at IS
  'Set only on a HIDDEN suggested row whose own author expressed interest at least 72h earlier. The '
  'row stays live and answerable; it simply stops counting against its author''s visible capacity. '
  'Never set on the counterparty''s visible actionable row. See migration 080.';

-- NO FOREIGN KEY on responds_to_id, deliberately — with the integrity it would have given supplied
-- by three other mechanisms instead. Stated in full because "we did not add a constraint" is not on
-- its own an argument.
--
-- WHY NOT THE FK. A self-referencing FK with ON DELETE SET NULL puts an RI action on the hottest
-- table in the product, and it turns deletion into a SILENT RE-CLASSIFICATION: a correlated
-- expression whose card is removed would quietly become an uncorrelated one, which is precisely the
-- state this migration exists to distinguish. delete_user_account() (075) also removes every
-- intro_requests row for a member in ONE statement, so parent and child of that FK sit inside a
-- single delete set. Both are avoidable rather than merely survivable.
--
-- WHAT REPLACES IT.
--   (1) LOCKED VALIDATION AT THE ONLY WRITE SITE. responds_to_id is written in exactly one place —
--       express_intro_interest() — and only from a card row that function has already SELECTed FOR
--       UPDATE and validated in the same transaction, under both members' advisory locks. A dangling
--       reference therefore cannot be CREATED; it can only appear later, by deletion.
--   (2) DANGLING IS INERT, NOT MERELY TOLERATED. Both consumers start from the CARD, not from the
--       expression. release_intro_capacity() updates `intro_requests t` and requires
--       `EXISTS (... e.responds_to_id = t.id ...)`; if t is gone the UPDATE matches zero rows, so an
--       orphan can never release anything, and it can never release something ELSE because the id it
--       carries is unique and dead. The waiting surface likewise joins card -> expression and renders
--       nothing for a missing card. There is no code path that dereferences responds_to_id blindly.
--   (3) A STANDING ORPHAN AUDIT. introduction_capacity_review emits an 'orphan_responds_to' row for
--       every expression whose card no longer exists, so the count is observable rather than assumed.
--       Rehearsed in scripts/verify-080-capacity-release.sh against both delete_user_account() and a
--       bulk multi-row delete: neither errors, neither releases capacity, neither leaks into the UI
--       query, and TRUNCATE ... CASCADE is likewise unaffected because no FK participates.

-- ── 2. LOCAL CONSTRAINT ───────────────────────────────────────────────────────────────────────
-- A CHECK can only see the row in front of it, so it asserts ONLY a local fact: a released row must
-- belong to a canonical pair. It deliberately does NOT require status = 'suggested', because the
-- row must remain free to become passed / expired / matched afterwards — that transition is the
-- whole point of keeping the card answerable. A constraint that pinned the status would break every
-- later transition and would be the second bug, not a safeguard.
--
-- The cross-row correlation (an expression pointing at THIS row) cannot be expressed here at all
-- and is NOT pretended at: it is enforced inside release_intro_capacity(), under the locks.
ALTER TABLE public.intro_requests
  DROP CONSTRAINT IF EXISTS intro_requests_released_requires_pair_chk;
ALTER TABLE public.intro_requests
  ADD CONSTRAINT intro_requests_released_requires_pair_chk
  CHECK (capacity_released_at IS NULL OR pair_id IS NOT NULL);

-- Partial index: every capacity counter now filters on this, and the release worker scans it.
CREATE INDEX IF NOT EXISTS intro_requests_capacity_live_idx
  ON public.intro_requests (requester_id)
  WHERE status = 'suggested' AND capacity_released_at IS NULL;
CREATE INDEX IF NOT EXISTS intro_requests_responds_to_idx
  ON public.intro_requests (responds_to_id) WHERE responds_to_id IS NOT NULL;

-- ── 3. DRIFT GUARD — FAIL CLOSED BEFORE ANY REPLACEMENT ───────────────────────────────────────
-- Migration 067 exists because consume_credits_and_create_match was created OUT OF BAND in the
-- Supabase dashboard and was absent from every migration file. A CREATE OR REPLACE written against
-- a repository file can therefore silently overwrite a DIFFERENT deployed body. This block is what
-- stops that, and it is deliberately exhaustive.
--
-- WHY IT IS NOT MARKER-BASED ANY MORE. The first version selected by proname with LIMIT 1 and
-- checked that a handful of substrings were still present. Both halves were unsound. A name-only
-- lookup picks an ARBITRARY row when an overload exists — exactly the situation an overload creates,
-- and exactly the situation in which replacing the wrong body does the most damage. And markers
-- survive almost any edit: a body can lose an entire capacity predicate while still containing
-- 'c_max_visible'. Markers are retained below only as a supplemental diagnostic that names the
-- missing concept in the error message; they are never the authority.
--
-- WHAT IS AUTHORITATIVE. Each function is resolved by its EXACT signature through to_regprocedure(),
-- which yields NULL rather than guessing, and is then pinned on nine independent properties:
-- signature presence, absence of any other overload of that name, identity arguments (name, type and
-- order), result type, md5(prosrc), length(prosrc), SECURITY DEFINER, empty search_path, and the
-- full role-execution posture including PUBLIC.
--
-- ON length(prosrc). It counts CHARACTERS, not octets. These bodies contain multi-byte characters in
-- their comments, so length() and octet_length() legitimately disagree — for materialize_admin_pair
-- by 178. The values below are length(), matching what the preflight reports; octet_length is
-- reported alongside it there so the two can never be confused again.
--
-- expire_intro_pair is in this list although 080 does NOT replace it. Pinning it here means a
-- collateral change to the 14-day delayed-mutual behaviour is caught BEFORE anything is written,
-- rather than discovered afterwards.
--
-- Every check raises. The whole migration is one transaction, so a single failure rolls back the
-- columns, the indexes, the constraint, the view and every function definition together.
DO $drift$
DECLARE
  r         record;
  v_oid     oid;
  v_proc    pg_catalog.pg_proc%ROWTYPE;
  v_n       integer;
  v_txt     text;
  v_cfg     text;
  v_missing text;
  v_role    text;
BEGIN
  -- The posture assertions below name these roles; has_function_privilege() errors on an unknown
  -- role, so an environment without them is refused explicitly rather than by accident.
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      RAISE EXCEPTION
        'DRIFT GUARD: role % does not exist. This is not the Supabase environment 080 was audited '
        'against; refusing to apply.', v_role;
    END IF;
  END LOOP;

  FOR r IN
    SELECT * FROM (VALUES
      ('create_reciprocal_suggestion'::text,
       'public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer)'::text,
       'a_id uuid, b_id uuid, p_source text, p_reason text, p_cooldown_days integer, p_max_cards integer'::text,
       'text'::text,
       '8d62f30d84f079c1dcc4aa22848dba9d'::text, 6103::integer, true::boolean,
       ARRAY['pg_advisory_xact_lock','c_max_visible','exists_active','cooldown','capacity','ineligible']::text[]),

      ('place_batch_rows',
       'public.place_batch_rows(uuid, text, jsonb, uuid, integer)',
       'p_member_id uuid, p_source text, p_rows jsonb, p_reciprocal_batch_id uuid, p_cooldown_days integer',
       'jsonb',
       '2eca64f2e35735feb6ca45212488885d', 11413, true,
       ARRAY['pg_advisory_xact_lock','c_max_visible','c_max_reserved']),

      ('promote_queued_rows',
       'public.promote_queued_rows(uuid)',
       'p_member_id uuid',
       'jsonb',
       '690f0f6aead9a4831073e32af8d53e1f', 6090, true,
       ARRAY['pg_advisory_xact_lock','c_max_visible','incomplete']),

      ('materialize_admin_pair',
       'public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer)',
       'p_review_batch_id uuid, p_member_a uuid, p_member_b uuid, p_batch_a uuid, p_batch_b uuid, p_cooldown_days integer',
       'jsonb',
       'd64aa2aa8627089cd82cbcbc586ddca1', 22015, true,
       ARRAY['pg_advisory_xact_lock','v_vis_lo','v_vis_hi']),

      -- NOT replaced by 080. Pinned so collateral drift is refused before any write.
      ('expire_intro_pair',
       'public.expire_intro_pair(uuid, integer)',
       'p_pair_id uuid, p_max_age_days integer',
       'jsonb',
       'c786da9312cf962eb06ec6463ceecfd8', 5146, false,
       ARRAY['pg_advisory_xact_lock','mutual_pending','one_sided_interest'])
    ) AS t(fname, sig, ident_args, result_type, want_md5, want_len, is_replaced, markers)
  LOOP
    ---------------------------------------------------------------- (1) exact signature resolves
    v_oid := pg_catalog.to_regprocedure(r.sig);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION
        'DRIFT GUARD: % is not deployed under that exact signature. 080 replaces functions by '
        'signature; refusing to apply against a different shape.', r.sig;
    END IF;

    ---------------------------------------------------------------- (2) no other overload of the name
    SELECT count(*) INTO v_n
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = r.fname;
    IF v_n <> 1 THEN
      RAISE EXCEPTION
        'DRIFT GUARD: public.% has % signatures deployed; exactly 1 expected. An overload means a '
        'caller may reach a body 080 never audited. Refusing to apply.', r.fname, v_n;
    END IF;

    SELECT * INTO v_proc FROM pg_catalog.pg_proc WHERE oid = v_oid;

    ---------------------------------------------------------------- (3) identity arguments
    v_txt := pg_catalog.pg_get_function_identity_arguments(v_oid);
    IF v_txt <> r.ident_args THEN
      RAISE EXCEPTION
        'DRIFT GUARD: public.% identity arguments differ. expected [%] deployed [%]',
        r.fname, r.ident_args, v_txt;
    END IF;

    ---------------------------------------------------------------- (4) result type
    v_txt := pg_catalog.pg_get_function_result(v_oid);
    IF v_txt <> r.result_type THEN
      RAISE EXCEPTION
        'DRIFT GUARD: public.% result type is % but % was audited.', r.fname, v_txt, r.result_type;
    END IF;

    ---------------------------------------------------------------- (5) EXACT body
    IF pg_catalog.md5(v_proc.prosrc) <> r.want_md5 THEN
      RAISE EXCEPTION
        'DRIFT GUARD: public.% body md5 is % but the audited body is %. The deployed body is NOT '
        'the one 080 was written against. Re-audit before applying.',
        r.fname, pg_catalog.md5(v_proc.prosrc), r.want_md5;
    END IF;
    IF pg_catalog.length(v_proc.prosrc) <> r.want_len THEN
      RAISE EXCEPTION
        'DRIFT GUARD: public.% body length(prosrc) is % but % was audited (characters, not octets).',
        r.fname, pg_catalog.length(v_proc.prosrc), r.want_len;
    END IF;

    ---------------------------------------------------------------- (6) security posture
    IF NOT v_proc.prosecdef THEN
      RAISE EXCEPTION
        'DRIFT GUARD: public.% is no longer SECURITY DEFINER. Replacing it would restate a '
        'privilege model that has already been changed out of band.', r.fname;
    END IF;

    v_cfg := pg_catalog.array_to_string(v_proc.proconfig, ',');
    -- Both spellings PostgreSQL uses for SET search_path = '' are accepted; nothing else is.
    IF v_proc.proconfig IS NULL OR v_cfg NOT IN ('search_path=', 'search_path=""') THEN
      RAISE EXCEPTION
        'DRIFT GUARD: public.% does not have an empty search_path (config: %).',
        r.fname, COALESCE(v_cfg, '(NONE)');
    END IF;

    ---------------------------------------------------------------- (7) role execution posture
    IF EXISTS (SELECT 1 FROM pg_catalog.unnest(COALESCE(v_proc.proacl, ARRAY[]::pg_catalog.aclitem[])) a
                WHERE a::text LIKE '=%') THEN
      RAISE EXCEPTION
        'DRIFT GUARD: public.% is EXECUTABLE BY PUBLIC. That is the 067 defect; refusing to apply '
        'on top of it.', r.fname;
    END IF;
    IF pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'DRIFT GUARD: anon can execute public.%; refusing to apply.', r.fname;
    END IF;
    IF pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'DRIFT GUARD: authenticated can execute public.%; refusing to apply.', r.fname;
    END IF;
    IF NOT pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION
        'DRIFT GUARD: service_role CANNOT execute public.%; the deployed grant model differs from '
        'the audited one.', r.fname;
    END IF;

    ---------------------------------------------------------------- (8) supplemental diagnostics
    -- Never the authority — (5) already decided it. These exist so a failure names the missing
    -- CONCEPT rather than only a hash, which is what an operator actually needs at 3am.
    SELECT pg_catalog.string_agg(m, ', ') INTO v_missing
      FROM pg_catalog.unnest(r.markers) AS m
     WHERE pg_catalog.strpos(v_proc.prosrc, m) = 0;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION
        'DRIFT GUARD: deployed public.% is missing expected markers (%).', r.fname, v_missing;
    END IF;

    ---------------------------------------------------------------- (9) not already release-aware
    IF pg_catalog.strpos(v_proc.prosrc, 'capacity_released_at') > 0 THEN
      RAISE EXCEPTION
        'DRIFT GUARD: deployed public.% already references capacity_released_at; 080 appears to be '
        'applied already. Refusing to replace a body that may be newer than this file.', r.fname;
    END IF;

    IF NOT r.is_replaced THEN
      -- Reached only when a pinned-but-not-replaced function is fully verified. 080 defines no
      -- body for it; this loop iteration exists purely to refuse collateral drift.
      NULL;
    END IF;
  END LOOP;
END;
$drift$;


-- ── 4. ATOMIC EXPRESSION WRITER ───────────────────────────────────────────────────────────────
-- Replaces an application-level check-then-insert. The previous flow SELECTed existing
-- pending/approved rows and then separately INSERTed one, so two concurrent clicks could both see
-- "none" and both insert; and because the select was ordered by created_at ASC it reused the OLDEST
-- row, resurrecting an expression from a previous recommendation epoch.
--
-- Idempotency is now scoped to responds_to_id: one expression per suggested row, enforced by a
-- partial unique index, so concurrent repeated interest on the SAME card converges on ONE row and
-- interest in a LATER re-recommendation is a genuinely new expression.
CREATE UNIQUE INDEX IF NOT EXISTS intro_requests_one_expression_per_card_uniq
  ON public.intro_requests (responds_to_id)
  WHERE responds_to_id IS NOT NULL
    AND status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending');

CREATE OR REPLACE FUNCTION public.express_intro_interest(
  p_suggested_id   uuid,
  p_requester_id   uuid,
  p_target_user_id uuid,
  p_note           text DEFAULT NULL
) RETURNS TABLE (out_state text, out_detail text, out_intro_request_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  s   public.intro_requests%ROWTYPE;
  pr  public.member_pairs%ROWTYPE;
  lo  uuid; hi uuid;
  v_target_status text;
  v_existing uuid;
  v_new uuid;
BEGIN
  -- p_requester_id is the AUTHENTICATED member, supplied by the server from the session. The client
  -- never sends it and can never override it: it names one row (the card) that must already belong
  -- to that member, so a forged value simply fails the ownership test below.
  IF p_suggested_id IS NULL OR p_requester_id IS NULL OR p_target_user_id IS NULL THEN
    RETURN QUERY SELECT 'invalid'::text, 'missing_argument'::text, NULL::uuid; RETURN;
  END IF;
  IF p_requester_id = p_target_user_id THEN
    RETURN QUERY SELECT 'invalid'::text, 'self_pair'::text, NULL::uuid; RETURN;
  END IF;

  -- Read the card ONCE, unlocked, only to learn who the two members are. Nothing is decided here;
  -- every check below is re-derived after the locks are held.
  SELECT * INTO s FROM public.intro_requests WHERE id = p_suggested_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_actionable'::text, 'card_missing'::text, NULL::uuid; RETURN;
  END IF;

  -- Canonical lock order over BOTH members, in the key space migrations 050/063/064/066 use, so an
  -- expression can never interleave with a placement, a promotion, a pass, an expiry or another
  -- expression for either participant. Canonical order is what makes it deadlock-free alongside
  -- expire_intro_pair and release_intro_capacity, which lock the same two keys the same way.
  lo := LEAST(s.requester_id, s.target_user_id);
  hi := GREATEST(s.requester_id, s.target_user_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  -- Re-read under the locks. The card may have been passed, expired or matched while we waited.
  SELECT * INTO s FROM public.intro_requests WHERE id = p_suggested_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_actionable'::text, 'card_missing'::text, NULL::uuid; RETURN;
  END IF;

  -- (a) The card is the acting member's OWN. A forged or foreign id stops here.
  IF s.requester_id <> p_requester_id THEN
    RETURN QUERY SELECT 'not_actionable'::text, 'not_owner'::text, NULL::uuid; RETURN;
  END IF;

  -- (b) The card points at the target the caller believes it points at. This binds the expression to
  --     one exact recommendation rather than to a person, so a card id paired with the wrong target
  --     can never produce an expression against a third member.
  IF s.target_user_id <> p_target_user_id THEN
    RETURN QUERY SELECT 'not_actionable'::text, 'target_mismatch'::text, NULL::uuid; RETURN;
  END IF;

  -- (c) It is a live, actionable SUGGESTION — not a terminal row, and not an expression row.
  --     capacity_released_at is deliberately NOT tested: a released card is still answerable, which
  --     is the whole point of releasing capacity without closing the card.
  IF s.status <> 'suggested' THEN
    RETURN QUERY SELECT 'not_actionable'::text, 'card_not_suggested'::text, NULL::uuid; RETURN;
  END IF;
  IF s.responds_to_id IS NOT NULL THEN
    RETURN QUERY SELECT 'not_actionable'::text, 'card_is_an_expression'::text, NULL::uuid; RETURN;
  END IF;

  -- (d) It carries a pair. The correlated lifecycle is pair-governed end to end: release requires a
  --     pair, and expire_intro_pair is what eventually closes it. A legacy pairless suggestion has
  --     no such lifecycle, so it must never enter this path.
  IF s.pair_id IS NULL THEN
    RETURN QUERY SELECT 'not_actionable'::text, 'card_has_no_pair'::text, NULL::uuid; RETURN;
  END IF;

  -- (e) The pair is still active. 'expired' / 'passed' / 'matched' / 'blocked' / 'ineligible' /
  --     'superseded' are all terminal for the purposes of answering a card.
  SELECT * INTO pr FROM public.member_pairs WHERE id = s.pair_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_actionable'::text, 'pair_missing'::text, NULL::uuid; RETURN;
  END IF;
  IF pr.status <> 'active' THEN
    RETURN QUERY SELECT 'not_actionable'::text, 'pair_not_active'::text, NULL::uuid; RETURN;
  END IF;

  -- (f) The target is still an eligible member.
  SELECT pf.account_status INTO v_target_status
    FROM public.profiles pf WHERE pf.id = s.target_user_id;
  IF v_target_status IS NULL THEN
    RETURN QUERY SELECT 'not_actionable'::text, 'target_missing'::text, NULL::uuid; RETURN;
  END IF;
  IF v_target_status <> 'active' THEN
    RETURN QUERY SELECT 'not_actionable'::text, 'target_ineligible'::text, NULL::uuid; RETURN;
  END IF;

  -- IDEMPOTENCY, SCOPED TO THIS CARD AND NOTHING ELSE.
  --
  -- The replaced application logic selected the member's pending/approved rows by (requester,
  -- target) ordered by created_at ASC and reused the OLDEST. After a cooldown re-recommendation that
  -- resurrected an expression from a PREVIOUS epoch, carrying its old created_at — and the release
  -- clock reads exactly that timestamp, so a brand-new card could have been released immediately.
  -- Correlation by identity removes the inference: an expression answers one card or no card.
  SELECT e.id INTO v_existing FROM public.intro_requests e
   WHERE e.responds_to_id = p_suggested_id
     AND e.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending')
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN QUERY SELECT 'already_expressed'::text, 'same_card'::text, v_existing; RETURN;
  END IF;

  -- pair_id is deliberately LEFT NULL on the expression row.
  --
  -- This is not an oversight and it is not cosmetic. expire_intro_pair (066) classifies a pair from
  -- `WHERE ir.pair_id = p_pair_id`: it demands exactly two open 'suggested' rows for the
  -- both-unanswered case, and exactly one for the one-sided case. The card the member answered STAYS
  -- 'suggested' (that is what keeps delayed mutual completion possible), so stamping pair_id onto
  -- the expression would leave the pair with two open suggested rows AND one-sided interest — a
  -- combination 066 refuses with 'unanswered_side_not_open'. The pair would never expire. Leaving it
  -- NULL reproduces today's shape exactly, so the existing 14-day expiry is preserved unchanged.
  INSERT INTO public.intro_requests
    (requester_id, target_user_id, status, note, responds_to_id)
  VALUES (s.requester_id, s.target_user_id, 'pending', p_note, s.id)
  RETURNING id INTO v_new;

  RETURN QUERY SELECT 'created'::text, 'ok'::text, v_new;
END;
$fn$;

REVOKE ALL ON FUNCTION public.express_intro_interest(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.express_intro_interest(uuid, uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.express_intro_interest(uuid, uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.express_intro_interest(uuid, uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.express_intro_interest(uuid, uuid, uuid, text) IS
  'THE production writer for Express Interest on a recommendation card. Validates ownership, target '
  'binding, actionability, suggestion-ness, pair presence, pair activity and target eligibility '
  'INSIDE both members'' advisory locks, then inserts one expression correlated to that exact card '
  'by responds_to_id. Idempotent per card. Leaves pair_id NULL so 066 expiry is unchanged. '
  'service_role only.';

-- ── 5. THE RELEASE RPC ────────────────────────────────────────────────────────────────────────
-- Frees ONE hidden directional row from its author's visible capacity. It is the only writer of
-- capacity_released_at.
--
-- IT NEVER TOUCHES status. That is load-bearing twice over: the card must stay answerable so
-- delayed mutual completion still works, and migration 070's outbox trigger is
-- `AFTER INSERT OR UPDATE OF status`, so an update that does not name status cannot fire it at all
-- and no "new introduction" email or notification can be enqueued by a release.
CREATE OR REPLACE FUNCTION public.release_intro_capacity(
  p_intro_request_id uuid,
  p_min_wait_hours   integer DEFAULT 72
) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  s   public.intro_requests%ROWTYPE;
  pr  public.member_pairs%ROWTYPE;
  lo  uuid; hi uuid;
  v_n integer;
BEGIN
  IF p_intro_request_id IS NULL THEN RETURN false; END IF;

  SELECT * INTO s FROM public.intro_requests WHERE id = p_intro_request_id;
  IF NOT FOUND OR s.pair_id IS NULL THEN RETURN false; END IF;

  SELECT * INTO pr FROM public.member_pairs WHERE id = s.pair_id;
  IF NOT FOUND THEN RETURN false; END IF;

  -- Canonical order, both members, same key space as 063. Serializes the release against placement,
  -- promotion, expression, pass and expiry for either participant.
  lo := LEAST(pr.user_a_id, pr.user_b_id);
  hi := GREATEST(pr.user_a_id, pr.user_b_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  -- Every condition is re-derived INSIDE the locks. A pass, an expiry or a match that landed
  -- between the scan and here makes this match zero rows.
  UPDATE public.intro_requests t
     SET capacity_released_at = pg_catalog.now()
   WHERE t.id = p_intro_request_id
     AND t.status = 'suggested'              -- never written, only required
     AND t.pair_id IS NOT NULL
     AND t.capacity_released_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.intro_requests e
        WHERE e.responds_to_id = t.id        -- IDENTITY correlation, not a timestamp inference
          AND e.requester_id  = t.requester_id
          AND e.target_user_id = t.target_user_id
          AND e.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending')
          -- the 72h clock starts when the member actually expressed interest in THIS card
          AND e.created_at <= pg_catalog.now()
                              - pg_catalog.make_interval(hours => GREATEST(COALESCE(p_min_wait_hours, 72), 0)));

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$fn$;

REVOKE ALL ON FUNCTION public.release_intro_capacity(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_intro_capacity(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.release_intro_capacity(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_intro_capacity(uuid, integer) TO service_role;

COMMENT ON FUNCTION public.release_intro_capacity(uuid, integer) IS
  'Frees one hidden suggested row from its OWN author''s visible capacity, 72h after that author '
  'expressed interest in it via responds_to_id. Never writes status, so the 070 outbox trigger '
  'cannot fire. Idempotent; returns true only when exactly one row transitioned. service_role only.';

-- ── 6. LEGACY / INELIGIBLE READ-ONLY OPERATOR VIEWS ──────────────────────────────────────────
-- Two populations must NOT be swept up by this feature, and neither is mutated here.
--
-- LEGACY (pair_id IS NULL): the release model is pair-based — the RPC requires pair_id and the
-- 14-day expiry is keyed on pair_id — so a pairless hidden row can be released by nothing and
-- expired by nothing. It is NOT given a delayed-mutual promise and NOT auto-expired here, because a
-- blind terminal expiry would close a card whose counterparty may still be able to answer. It is
-- surfaced for explicit operator review instead.
--
-- INELIGIBLE OWNERS: an open card whose requester is inactive or incomplete. Placement already gates
-- on eligibility at creation, but nothing re-checks an already-open card. Prospective exclusion
-- lives in the worker; this view is the operator's read-only list.
CREATE OR REPLACE VIEW public.introduction_capacity_review AS
  SELECT
    'legacy_pairless_hidden'::text AS review_kind,
    ir.id                          AS intro_request_id,
    ir.created_at,
    date_part('day', pg_catalog.now() - ir.created_at)::int AS age_days
  FROM public.intro_requests ir
  WHERE ir.status = 'suggested'
    AND ir.pair_id IS NULL
    AND EXISTS (SELECT 1 FROM public.intro_requests e
                 WHERE e.requester_id = ir.requester_id
                   AND e.target_user_id = ir.target_user_id
                   AND e.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending'))
  UNION ALL
  SELECT
    'ineligible_owner'::text,
    ir.id,
    ir.created_at,
    date_part('day', pg_catalog.now() - ir.created_at)::int
  FROM public.intro_requests ir
  JOIN public.profiles p ON p.id = ir.requester_id
  WHERE ir.status = 'suggested'
    AND (p.account_status IS DISTINCT FROM 'active' OR p.profile_complete IS DISTINCT FROM true)
  UNION ALL
  -- ORPHANED CORRELATION. responds_to_id carries no foreign key (see the header note), so this is
  -- the standing read-only audit that proves the absence of one is not hiding anything. An orphan is
  -- inert by construction: release_intro_capacity starts from the CARD and requires a live
  -- correlated expression, and the waiting surface joins card -> expression, so a row pointing at a
  -- vanished card can neither release capacity nor render anywhere. This exists so an orphan is
  -- still COUNTED rather than merely harmless.
  SELECT
    'orphan_responds_to'::text,
    ir.id,
    ir.created_at,
    date_part('day', pg_catalog.now() - ir.created_at)::int
  FROM public.intro_requests ir
  WHERE ir.responds_to_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.intro_requests c WHERE c.id = ir.responds_to_id);

REVOKE ALL ON public.introduction_capacity_review FROM PUBLIC;
REVOKE ALL ON public.introduction_capacity_review FROM anon;
REVOKE ALL ON public.introduction_capacity_review FROM authenticated;
GRANT SELECT ON public.introduction_capacity_review TO service_role;

COMMENT ON VIEW public.introduction_capacity_review IS
  'Read-only operator list of rows this feature deliberately does NOT touch: hidden waiting rows '
  'with no pair (unreleasable and unexpirable by the pair model), open cards whose requester is '
  'no longer eligible, and expressions whose correlated card no longer exists (the standing orphan '
  'audit that stands in for the absent foreign key). Emits ids and ages only - no member identity. '
  'Nothing here is mutated by migration 080.';

-- ── 7. THE FOUR CAPACITY WRITERS, REPLACED ────────────────────────────────────────────────────
-- Bodies transcribed from the committed 063/064 files. The ONLY differences are the six counted
-- capacity predicates listed in the header. Signatures, locks, caps, gates, error strings,
-- search_path and schema qualification are otherwise identical.

-- ── create_reciprocal_suggestion ──
CREATE OR REPLACE FUNCTION public.create_reciprocal_suggestion(
  a_id uuid,
  b_id uuid,
  p_source text DEFAULT 'reciprocal',
  p_reason text DEFAULT NULL,          -- genuine fit reason (or NULL); NOT the label
  p_cooldown_days integer DEFAULT 30,
  p_max_cards integer DEFAULT 2        -- >=1 is clamped to c_max_visible; NULL/<=0 -> 'invalid'
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


-- ── place_batch_rows ──
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
  SELECT count(*) FILTER (WHERE ir.status = 'suggested' AND ir.capacity_released_at IS NULL),
         count(*) FILTER (WHERE ir.status = 'queued')
    INTO v_visible, v_reserved
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

  v_visible_free  := GREATEST(0, c_max_visible  - v_visible);
  v_reserved_free := GREATEST(0, c_max_reserved - v_reserved);

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


-- ── promote_queued_rows ──
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

  -- (1) Re-count VISIBLE after completion. Pair-governed reciprocal cards survive it and count.
  SELECT count(*) INTO v_visible FROM public.intro_requests ir
    WHERE ir.requester_id = p_member_id AND ir.status = 'suggested'
      AND ir.capacity_released_at IS NULL;
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


-- ── materialize_admin_pair ──
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
  SELECT count(*) FILTER (WHERE ir.status = 'suggested' AND ir.capacity_released_at IS NULL),
         count(*) FILTER (WHERE ir.status = 'queued')
    INTO v_vis_lo, v_res_lo
  FROM public.intro_requests ir WHERE ir.requester_id = lo;
  SELECT count(*) FILTER (WHERE ir.status = 'suggested' AND ir.capacity_released_at IS NULL),
         count(*) FILTER (WHERE ir.status = 'queued')
    INTO v_vis_hi, v_res_hi
  FROM public.intro_requests ir WHERE ir.requester_id = hi;

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



-- ── 8. GRANTS RESTATED ────────────────────────────────────────────────────────────────────────
-- CREATE OR REPLACE preserves privileges, so these assert the intended state rather than change it.
-- Restating them means a future reader can see the intended ACL without opening 063/064.
REVOKE ALL ON FUNCTION public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.place_batch_rows(uuid, text, jsonb, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_batch_rows(uuid, text, jsonb, uuid, integer) TO service_role;
REVOKE ALL ON FUNCTION public.promote_queued_rows(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_queued_rows(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer) TO service_role;

-- The browser must not be able to write the new columns. Migration 055 already revoked INSERT and
-- UPDATE on intro_requests from anon/authenticated; this restates it so 080 is self-describing.
REVOKE INSERT, UPDATE, DELETE ON public.intro_requests FROM PUBLIC, anon, authenticated;

COMMIT;
