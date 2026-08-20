-- 064_materialize_admin_pair.sql
--
-- ATOMIC TWO-SIDED MATERIALIZATION FOR A REVIEWED ADMIN PAIR.
--
-- NOT YET APPLIED. Operator applies in the Supabase Dashboard after review.
-- Migration 063 is applied and is NOT modified by this file.
--
-- ─── WHAT THIS FIXES ─────────────────────────────────────────────────────────────────────────────
-- Admin approval materialised one RECIPIENT at a time: approve-batch looped members and called
-- public.place_batch_rows once each, in separate committed transactions. That function inserts ONE
-- direction only (requester = p_member_id) while its eligibility gate is BIDIRECTIONAL. So for a
-- reviewed pair {A,B}: A's call commits (A→B,'suggested'); B's call then SEES that row and filters
-- A out. Every admin-batch edge collapsed to one side. The production audit measured the result:
-- 145 live one-sided rows (90 'suggested', 55 'queued'), ALL with pair_id IS NULL — i.e. all from
-- the batch path — and ZERO from create_reciprocal_suggestion, which writes both directions in one
-- transaction and produced no defects at all.
--
-- This function is the pair-shaped equivalent of that correct path, plus the review provenance
-- neither existing function can express:
--   • create_reciprocal_suggestion writes both directions correctly, but leaves batch_id NULL,
--     never touches recommendation_batches, and validates no review proposal. It therefore cannot
--     carry admin review provenance or participate in the member-level batch lifecycle.
--   • place_batch_rows carries that provenance, but is single-sided by construction.
-- Neither can be reused as-is, which is why a new function exists rather than a call to an old one.
--
-- ─── TWO-MEMBER PROVENANCE ───────────────────────────────────────────────────────────────────────
-- recommendation_batches is keyed per MEMBER (member_id, one partial-unique 'active' row and one
-- partial-unique 'queued' row each). The two directional intro_requests rows therefore belong to
-- DIFFERENT member-level batches and must carry DIFFERENT batch_id values. Forcing a single
-- batch_id onto both would attribute one member's card to the other member's batch and corrupt
-- every per-member lifecycle query. Each side gets its own; both are returned for inspection.
--
-- p_batch_a / p_batch_b are OPTIONAL, and this is safe because THERE IS NOTHING AMBIGUOUS TO
-- RESOLVE. recommendation_batches carries a partial unique index of one 'active' row per member, so
-- the lookup in step (15) has cardinality zero or one: it is a unique-key read, not a choice among
-- candidates. There is no ordering, no "most recent", and no tie to break, and completed/discarded
-- history cannot participate because it is not state='active'. Requiring the ids instead would be
-- impossible for the FIRST pair of a review batch, whose member-level batch does not exist yet.
-- When an id IS supplied it must equal the row the unique-key lookup found, mapped through
-- canonical order, so a caller can never bind a pair into a batch that is not its own member's.
--
-- ─── WHAT AN ACTIVE recommendation_batches ROW ACTUALLY MEANS ────────────────────────────────────
-- It is the member's CURRENT VISIBLE DELIVERY ENVELOPE, not a review cycle. Traced, not assumed:
--   * The member UI never reads this table at all — app/dashboard/introductions/page.tsx selects
--     from intro_requests only. What a member SEES is decided by intro_requests.status.
--   * place_batch_rows APPENDS into an existing active batch whose batch_source matches, and never
--     rewrites its reciprocal_batch_id. So that column records which producer call first CREATED
--     the envelope; it was never a per-card attribution.
--   * displayed_at anchors the 7-day engagement reminder, deduped once per batch_id
--     (app/api/cron/engagement-reminders).
--   * promote_queued_rows is the ONLY writer of state='completed', and it completes an active
--     batch when the member has resolved it and a queued batch is waiting to take the slot.
--   * queue-metrics reads the timestamps for analytics.
--
-- This is why production shows 23 active member envelopes spanning 3 distinct reciprocal_batch_id
-- values while only 1 review batch is active: envelopes outlive review cycles. A member's envelope
-- persists until promotion completes it, so it still names whichever review first created it.
--
-- ─── OLD ENVELOPE + NEW CARD (the underfill this must not preserve) ──────────────────────────────
-- An earlier draft required reciprocal_batch_id = p_review_batch_id to reuse an envelope. That was
-- STRICTER THAN PRODUCTION SEMANTICS and would have refused exactly the members this work exists to
-- help: an underfilled member holding one visible card from an older review cycle would have been
-- permanently unable to receive a second. The rule is now:
--
--   no active envelope                         -> create one, stamped with THIS review batch
--   envelope holds NO live suggested/queued row -> it is stale: retire it (state='completed',
--                                                 completed_at set — the same transition
--                                                 promote_queued_rows makes) and create a fresh
--                                                 envelope stamped with THIS review batch. Nothing
--                                                 visible is touched, because nothing live is in it.
--   envelope holds live rows, source admin      -> REUSE it, whatever review created it. Its
--                                                 reciprocal_batch_id is left ALONE.
--   envelope holds live rows, source NOT admin  -> refuse 'active_batch_source_conflict'.
--
-- Reusing does not falsify provenance, because the envelope never carried per-card provenance.
-- Rewriting reciprocal_batch_id, by contrast, WOULD falsify it — so it is never rewritten.
--
-- ─── PROVENANCE RETENTION, STATED HONESTLY ───────────────────────────────────────────────────────
-- WHILE the review batch exists:
--   * EXACT review provenance for a card = its symmetric pair of batch_suggestions rows under that
--     introduction_batches parent. This is the only exact record, and it is what replay validates.
--   * intro_requests.batch_id identifies the member's DELIVERY ENVELOPE — which review proposed that
--     particular card is NOT derivable from it, because an envelope may span review cycles.
--   * member_pairs.source = 'admin' preserves only COARSE provenance: an admin path created it.
--
-- AFTER the review batch is deleted:
--   * batch_suggestions rows are removed by ON DELETE CASCADE, so EXACT review-level proposal
--     provenance is GONE. It does not survive deletion, and this file does not pretend otherwise.
--   * The live cards survive (no FK from intro_requests to introduction_batches), as does pair_id
--     and the coarse member_pairs.source. A member never loses a card to a review deletion.
--   * A replay attempted after deletion returns 'invalid' / 'review_batch_not_found' and writes
--     nothing — a documented, non-actionable result rather than a repair attempt.
-- Whether approved review batches should become non-deletable is a product decision, reported
-- separately; this migration does not change deletion behaviour.
--
-- The last case is an honest limitation, not an oversight: appending an admin card to a live
-- onboarding/weekly envelope would make batch_source a lie, and retiring that envelope would hide
-- cards the member can currently see. Neither is acceptable, so the pair waits.
--
-- ─── VISIBLE TIER ONLY. A PAIR NEVER ENTERS THE RESERVED TIER. ───────────────────────────────────
-- A pair is placed 'suggested' for BOTH members, or not at all.
--
-- An earlier draft of this function also allowed 'queued' for both. That is NOT SAFE, and the
-- reason is promotion, not placement. public.promote_queued_rows (migration 063) operates on ONE
-- member and contains zero references to pair_id. It is called from five member-triggered paths —
-- express-interest, accept-incoming, createIntroRequest, and app/actions.ts — so it runs whenever a
-- member acts on ANY card. Given a queued pair {A,B}: A acts on an unrelated card, A's promotion
-- runs, A's half of the pair becomes 'suggested', and B's half stays 'queued'. A can now see and
-- act on an introduction B cannot see. That is precisely the response-timing asymmetry this whole
-- design exists to prevent, reintroduced after placement by an unrelated action.
--
-- Placing pairs visible-only makes the safety property provable rather than argued:
--     NO row created by this function ever has status 'queued',
--     therefore promotion can never split a pair.
-- The reserved tier is untouched and still fully used by place_batch_rows for the single-member
-- producers (onboarding, weekly), which have no two-sided invariant to protect.
--
-- The cost is honest and bounded: a pair whose members lack visible room returns 'capacity' and
-- stays reviewable, to be approved later when room frees. Nothing is lost, only deferred.
--
-- Enabling queued placement for pairs REQUIRES making promotion pair-aware first (promote both
-- halves under both members' locks, or neither). That is a separate, reviewable change to an
-- applied, cron-and-member-triggered function and is deliberately NOT bundled here.
--
-- ─── STATUS VALUES ───────────────────────────────────────────────────────────────────────────────
-- Traced from current application code, not assumed:
--   introduction_batches.status : 'pending_review' (generate-batch insert) → 'active' (approve) →
--                                 'completed' (superseded by the next approval). Column default is
--                                 'active'; only these three are ever written.
--   batch_suggestions.status    : 'generated' (insert) → 'shown' (materialised, sets shown_at and
--                                 materialized_at) | 'dropped' | 'passed' | 'hidden_permanent'.
--                                 An approvable proposal is 'generated' with materialized_at NULL.
--   intro_requests.status       : 'suggested' (visible tier) | 'queued' (reserved tier), matching
--                                 migration 063's contract exactly.
--
-- ─── NO WRITE BEFORE THE LAST FAIL-CLOSED CHECK ──────────────────────────────────────────────────
-- A PL/pgSQL function shares the CALLER'S transaction. `RETURN` is not a rollback: anything already
-- inserted stays inserted. So every check that can return a non-created outcome runs BEFORE the
-- first INSERT, without exception — including the member_pairs status policy, the pair cooldown,
-- the recommendation_batches provenance check and the supplied-batch-id check. The canonical
-- member_pairs row is READ in the validation phase and only CREATED in the write phase.
--
-- (For the record: public.create_reciprocal_suggestion in migration 063 inserts its member_pairs
-- row before its cooldown check, so a 'cooldown' refusal there can leave a new pair row behind.
-- That function is applied and is not modified here; 064 simply does not repeat the pattern.)
--
-- ─── MEMBER_PAIR STATUS POLICY ───────────────────────────────────────────────────────────────────
-- member_pairs.status is CHECKed to ('active','expired','passed','matched','blocked','ineligible',
-- 'superseded') by migration 050. An existing row's status is authoritative and is NEVER silently
-- reactivated:
--   matched     -> 'already_matched'. Terminal. The two are connected; re-recommending is wrong even
--                  if the matches row were somehow absent.
--   blocked     -> 'blocked'. Terminal.
--   ineligible  -> 'ineligible'. Terminal through THIS path: it records a pair-level judgement that
--                  the per-profile eligibility recheck cannot see or overturn. Fail closed.
--   superseded  -> 'invalid' / 'pair_status_superseded'. The repository does not define what
--                  supersedes a pair, so this path refuses rather than guessing. Fail closed, and
--                  documented so the rule is a decision rather than an oversight.
--   active      -> allowed, subject to the pair cooldown. A live pair is already caught earlier by
--                  the exists_active probe; reaching here with 'active' means no live rows remain,
--                  i.e. a resolved-but-not-restatused pair.
--   passed      -> allowed, subject to the pair cooldown.
--   expired     -> allowed, subject to the pair cooldown.
-- Only the last three can proceed, and only after last_recommended_at clears the cooldown window.
--
-- ─── REPLAY REQUIRES EXACT SYMMETRY ──────────────────────────────────────────────────────────────
-- 'already_materialized' is returned only when the world is exactly as a successful call would have
-- left it: one materialised proposal in each direction and no approvable leftovers, exactly two live
-- rows (one per direction) sharing one non-null pair_id that identifies the canonical member_pairs
-- row, both 'suggested', each carrying its OWN member's admin_reciprocal batch, and both batches
-- pointing at this review batch. A count of "two or more materialised proposals" is NOT sufficient —
-- two materialised A->B duplicates with no B->A row would satisfy it. Anything short of full
-- symmetry returns 'invalid' / 'materialized_state_inconsistent'; nothing is repaired automatically.
--
-- ─── NO UNIQUE INDEX TO LEAN ON ──────────────────────────────────────────────────────────────────
-- intro_requests has NO unique constraint on (requester_id, target_user_id) and no self-pair CHECK.
-- Idempotency therefore cannot be delegated to ON CONFLICT: it is established by taking both member
-- advisory locks FIRST, then re-reading live state inside the lock. Self-pairs are rejected
-- explicitly. This is also why duplicate same-direction rows are physically possible in the data —
-- see the odd-counterpart diagnostic.
--
-- ─── SECURITY ────────────────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER with SET search_path = ''; every object schema-qualified. Execute is revoked from
-- PUBLIC/anon/authenticated and granted only to service_role. No table grant and no RLS policy is
-- created, altered or dropped by this migration. Nothing is logged; the returned jsonb carries an
-- outcome code, the chosen tier, and provenance ids — never a raw database error, an email, a name,
-- or any profile payload. Notifications and emails are the caller's job and are NOT done in SQL.

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
  SELECT count(*) FILTER (WHERE ir.status = 'suggested'),
         count(*) FILTER (WHERE ir.status = 'queued')
    INTO v_vis_lo, v_res_lo
  FROM public.intro_requests ir WHERE ir.requester_id = lo;
  SELECT count(*) FILTER (WHERE ir.status = 'suggested'),
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

REVOKE ALL ON FUNCTION public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer)
  TO service_role;
