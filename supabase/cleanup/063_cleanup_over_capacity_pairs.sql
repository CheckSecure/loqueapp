-- 063_cleanup_over_capacity_pairs.sql
--
-- ██ SAFE TO RUN AS CHECKED IN: the mutation gate below is false, so this file performs the
-- ██ read-only preflight and every verification, then stops before the first write.
-- ██ NOT PART OF MIGRATION 063. Requires separate approval.
--
-- Migration 063 PREVENTS new over-capacity members. This file REPAIRS the four that already exist.
-- They are deliberately separate: one is a schema change that touches no rows, the other mutates
-- live member-facing data and must be reviewed on its own terms.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- IT OPERATES ON A FIXED MANIFEST, NOT ON A DISCOVERED POPULATION
--
-- An earlier draft found "whichever members are over capacity right now" and repaired them. That is
-- unsafe: if the population changed between review and execution, the script would have silently
-- operated on rows nobody approved. Every id it may touch is now hard-coded below, captured from a
-- read-only production preflight (063_cleanup_preflight.sql) run 2026-08-19T22:52:44Z against
-- PostgreSQL 17.6. The script NEVER re-derives that set. It still counts the live over-capacity
-- population, but only to ASSERT that it is exactly the manifest — a different set of four members
-- with the same shape aborts the run rather than being substituted in.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE EXECUTION GATE
--
--     v_apply constant boolean := false;
--
-- With it false the DO block runs every guard, reports pass counts, and returns before the first
-- write. To apply, an operator edits that single literal to true. No session variable, no psql
-- :variable, no environment substitution, no dynamic SQL, no external snippet — the file you review
-- is the file that runs, and one word on one line separates "report" from "apply".
--
-- TRANSACTION HANDLING. No BEGIN/COMMIT here. The DO block is a single statement, so under psql's
-- default autocommit it is its own atomic transaction: it completes entirely or leaves nothing
-- behind. Any RAISE aborts the whole thing. To rehearse the mutation path without committing:
--
--     { echo "BEGIN;"; cat 063_cleanup_over_capacity_pairs.sql; echo "ROLLBACK;"; } | psql "$URL"
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY TABLE LOCKS, NOT ONLY THE ADVISORY LOCK — A REAL TOCTOU HOLE, CLOSED
--
-- An advisory lock only excludes code that takes the SAME advisory key. That was assumed to cover
-- every writer; it does not. Proven from the repository and the live catalog:
--
--   • public.expire_stale_reciprocal_pairs takes NO advisory lock — it uses FOR UPDATE SKIP LOCKED
--     on member_pairs only — and it UPDATEs both intro_requests (suggested -> expired) and
--     member_pairs. It is the weekly rotation, and the manifest's two pairs become stale on
--     2026-08-26 and 2026-08-27, i.e. the very next Thursday runs. This is a scheduled collision,
--     not a theoretical one.
--   • lib/introRequests/index.ts inserts an expressed-interest row ('pending') with no advisory lock.
--   • app/api/intro-requests/accept-incoming/route.ts inserts 'approved' with no advisory lock.
--
-- So verification and mutation must be protected by something every writer respects. This script
-- therefore takes SHARE ROW EXCLUSIVE on the three tables BEFORE its first verification query and
-- holds them to commit. That mode conflicts with ROW EXCLUSIVE (which every INSERT/UPDATE/DELETE
-- acquires) so concurrent writes block, while plain SELECT (ACCESS SHARE) still proceeds; it also
-- self-conflicts, so two copies of this script serialize.
--
-- FIXED ORDER, alphabetical and documented, so two runs cannot deadlock each other:
--     intro_requests -> member_pairs -> recommendation_batches
--
-- BOUNDED WAIT. lock_timeout is set to 5s LOCAL to this transaction. If another writer holds a
-- conflicting lock the script aborts with 55P03 and changes nothing, rather than queueing behind it
-- and blocking the application. The advisory locks are still taken as well: they cost nothing and
-- keep this script ordered against the capacity RPCs on the same key they use.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT IT REPAIRS
--
-- Four members hold three VISIBLE cards each: one onboarding reciprocal card (batch_id NULL,
-- pair_id set) plus two admin_reciprocal cards from one active batch. They are two reciprocal
-- PAIRS. Because the UI orders created_at DESC and slices to two, the reciprocal card is the hidden
-- one on BOTH sides of both pairs; neither participant has ever seen the introduction and nobody
-- has expressed interest on any of the three cards.
--
-- THE FIX: keep the reciprocal card, move ONE admin card per member from 'suggested' to 'queued'.
-- Nothing is deleted. The demoted card becomes a reservation and returns through normal promotion
-- once a visible slot frees. Every member sees two cards before and two after.
--
-- THE NEW QUEUED BATCH PRESERVES reciprocal_batch_id. An earlier draft set it to NULL. That was
-- wrong. All four production active batches carry reciprocal_batch_id = 37802a5c-..., the
-- introduction_batches run that produced them (approve-batch passes it as reciprocalBatchId), so it
-- is admin attribution/provenance. Dropping it would silently detach the demoted card from the run
-- it came from. Preserving it is also what migration 063 itself does: promote_queued_rows copies
-- v_queued.reciprocal_batch_id when it splits a batch. Schema-safe too — the live catalog shows the
-- column is nullable, has NO foreign key, and its only index (recommendation_batches_reciprocal_idx)
-- is NON-unique, so an active and a queued batch may share the value.
--
-- IT DOES NOT ORPHAN THE CARD FROM BATCH LIFECYCLE. promote_queued_rows never reads
-- reciprocal_batch_id for control flow: it finds the queued batch by (member_id, state='queued')
-- and the rows by (requester_id, batch_id, status='queued'). The value is carried, never consulted.
-- Rehearsal test 5 proves end to end that each demoted card is discovered and revealed by the real
-- promotion RPC.
--
-- WHICH ADMIN CARD — A DETERMINISTIC DEMOTION RULE, NOT A RANKING. These rows carry no persisted
-- score, rank or ordering column, so calling one "lower-ranked" would assert a judgement the data
-- cannot support. The rule is mechanical: ORDER BY created_at DESC, id DESC, take the first row.
-- In production BOTH admin cards of a member share created_at to the millisecond, so the id
-- comparison decides every case. Arbitrary, but stable, repeatable, and the same order
-- place_batch_rows uses when it stops placing. The chosen ids are recorded in the manifest below,
-- which is how the change stays hand-reversible without printing anything at runtime.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE PRE-EXISTING INCONSISTENCY BASELINE — OUT OF SCOPE, BUT PROVEN DISJOINT
--
-- Production reports batches_with_wrong_status_rows = 6: six (batch, intro_request) pairs where an
-- active batch holds a non-'suggested' row or a queued batch holds a non-'queued' row. They predate
-- this work and are NOT this task's business. This script therefore does three things with them and
-- nothing more:
--   • asserts the count is exactly the captured baseline of 6 before writing (guard 13);
--   • proves NONE of them touches any manifest member, batch, pair or intro_request (guard 14);
--   • asserts the count is still exactly 6 afterwards (postcondition), so the repair neither fixed
--     nor worsened them.
-- It does not read their contents, does not investigate them and does not modify them.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- OUTPUT IS AGGREGATE-ONLY
--
-- No NOTICE and no result set emits a member id, pair id, batch id or intro_request id. The
-- manifest holds those, in the SQL text, for the operator reading the file — never in output. Every
-- runtime message is a check name, a count or a boolean.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────


-- ═════ SECTION A — PREFLIGHT SUMMARY (read-only; always runs; aggregate only) ═══════════════════

SELECT
  (SELECT count(*) FROM (SELECT requester_id FROM public.intro_requests WHERE status='suggested'
                          GROUP BY 1 HAVING count(*) > 2) x)              AS members_over_visible_cap,
  (SELECT count(*) FROM (SELECT requester_id FROM public.intro_requests WHERE status='queued'
                          GROUP BY 1 HAVING count(*) > 2) x)              AS members_over_reserved_cap,
  (SELECT count(*) FROM public.intro_requests WHERE status='suggested')   AS total_suggested_rows,
  (SELECT count(*) FROM public.intro_requests WHERE status='queued')      AS total_queued_rows,
  (SELECT count(*) FROM public.recommendation_batches b
     JOIN public.intro_requests i ON i.batch_id = b.batch_id
    WHERE (b.state='active' AND i.status <> 'suggested')
       OR (b.state='queued' AND i.status <> 'queued'))                    AS wrong_status_rows_baseline_expect_6;
-- EXPECT: 4, 0, 153, 119, 6   (values as captured 2026-08-19T22:52:44Z; totals may drift with
-- normal activity — only the first, second and fifth are asserted by the guards below.)


-- ═════ SECTION B — MANIFEST, GUARDS, GATED MUTATION ═════════════════════════════════════════════

DO $$
DECLARE
  ---------------------------------------------------------------------------------------------
  -- ██ THE GATE. Edit this single literal to true to apply. Nothing else in the file changes. ██
  ---------------------------------------------------------------------------------------------
  v_apply constant boolean := false;

  ---------------------------------------------------------------------------------------------
  -- ██ THE IMMUTABLE TARGET MANIFEST — captured from production 2026-08-19T22:52:44Z.        ██
  -- ██ These are the ONLY rows this script may ever touch. Nothing is discovered at runtime. ██
  ---------------------------------------------------------------------------------------------
  v_manifest constant jsonb := '[
    {"member":"9738c747-c00e-4588-a4fc-1b74dcfd85e6",
     "pair":"b4243cdb-87a8-4205-a01c-1ff72f132d95",
     "counterpart":"d11d1c98-e016-497f-9308-e5a4f3caa146",
     "recip_intro":"286844dd-4774-4510-a1e7-673b3b0a248c",
     "batch":"838a72af-1fe1-4e6a-b804-3e0005703408",
     "batch_source":"admin_reciprocal","batch_state":"active",
     "recip_batch_id":"37802a5c-7420-44e8-ac94-9a413a6ab5bb",
     "demote":"d1e85858-41dc-45be-9afd-8070611b67d8",
     "demote_target":"96fd1e65-3ff0-4f2f-9250-45c4aa1d4104",
     "keep":"c2444511-e3d5-43e5-ae4d-b29e42576bca",
     "keep_target":"9ae6f563-ae0b-492e-b2ae-a7b24024c76c",
     "admin_created_at":"2026-08-13T23:19:21.855+00:00"},
    {"member":"a8111428-6825-49c3-a2a0-419cd8b11b52",
     "pair":"fcb68220-59d5-4f81-8490-401c46dc66d8",
     "counterpart":"d5a385d5-5526-4c8e-b17b-74a371b7fd6d",
     "recip_intro":"51a1e565-0a15-43c2-aadc-aa869d4d9786",
     "batch":"1f0db080-9094-4db4-a741-18a134389139",
     "batch_source":"admin_reciprocal","batch_state":"active",
     "recip_batch_id":"37802a5c-7420-44e8-ac94-9a413a6ab5bb",
     "demote":"87d02f58-a954-4904-9718-08d7740fca3c",
     "demote_target":"7365cb8f-3ecf-437e-9a66-1b59d1e12f2d",
     "keep":"18c2a37d-9680-4d98-8911-e5df318fa572",
     "keep_target":"fe06c087-c82e-445a-a3cf-6b44dd542574",
     "admin_created_at":"2026-08-13T23:19:19.507+00:00"},
    {"member":"d11d1c98-e016-497f-9308-e5a4f3caa146",
     "pair":"b4243cdb-87a8-4205-a01c-1ff72f132d95",
     "counterpart":"9738c747-c00e-4588-a4fc-1b74dcfd85e6",
     "recip_intro":"bedcc78f-8107-462b-b8c6-3d9c885aeb02",
     "batch":"3b424572-0ec9-43af-933d-b72de1ed6c11",
     "batch_source":"admin_reciprocal","batch_state":"active",
     "recip_batch_id":"37802a5c-7420-44e8-ac94-9a413a6ab5bb",
     "demote":"77f368e5-fa2a-4ed1-b38c-5379c7dbcea8",
     "demote_target":"7a5789ae-5d9d-4d7d-b175-a14bf25de2b1",
     "keep":"212363e9-4e15-4225-be65-73c1077b56de",
     "keep_target":"d9168bc9-8674-41ad-a2cd-2fd07ec24e5e",
     "admin_created_at":"2026-08-13T23:19:19.275+00:00"},
    {"member":"d5a385d5-5526-4c8e-b17b-74a371b7fd6d",
     "pair":"fcb68220-59d5-4f81-8490-401c46dc66d8",
     "counterpart":"a8111428-6825-49c3-a2a0-419cd8b11b52",
     "recip_intro":"376fac0a-81e2-4705-9230-382705aee204",
     "batch":"4f7f5f15-9ecb-40cb-9819-d2e211eb1674",
     "batch_source":"admin_reciprocal","batch_state":"active",
     "recip_batch_id":"37802a5c-7420-44e8-ac94-9a413a6ab5bb",
     "demote":"dbfbff2a-baa9-45af-8bc6-07fec628e442",
     "demote_target":"889f4b2e-90c4-4a3d-a344-5c11ce971679",
     "keep":"46d19e29-e9f0-4ddc-9d14-0098fd9c08c6",
     "keep_target":"e0c4e38d-0868-4f17-a79a-7313fec0a8b7",
     "admin_created_at":"2026-08-13T23:19:20.684+00:00"}
  ]'::jsonb;

  v_pair_manifest constant jsonb := '[
    {"pair":"b4243cdb-87a8-4205-a01c-1ff72f132d95",
     "user_a":"9738c747-c00e-4588-a4fc-1b74dcfd85e6",
     "user_b":"d11d1c98-e016-497f-9308-e5a4f3caa146",
     "a_to_b":"286844dd-4774-4510-a1e7-673b3b0a248c",
     "b_to_a":"bedcc78f-8107-462b-b8c6-3d9c885aeb02",
     "source":"onboarding","status":"active"},
    {"pair":"fcb68220-59d5-4f81-8490-401c46dc66d8",
     "user_a":"a8111428-6825-49c3-a2a0-419cd8b11b52",
     "user_b":"d5a385d5-5526-4c8e-b17b-74a371b7fd6d",
     "a_to_b":"51a1e565-0a15-43c2-aadc-aa869d4d9786",
     "b_to_a":"376fac0a-81e2-4705-9230-382705aee204",
     "source":"onboarding","status":"active"}
  ]'::jsonb;

  -- md5 of the id manifest, computed identically by the preflight. Recomputed below as a single
  -- end-to-end drift check that catches anything the individual guards miss.
  v_expected_digest constant text := '4f18a7510f83272e51a3c9aadc769f82';
  -- Captured baseline of PRE-EXISTING, out-of-scope batch/row status inconsistencies.
  v_baseline_wrong_status constant integer := 6;

  c_max_visible  constant integer := 2;
  c_max_reserved constant integer := 2;
  c_expected_members constant integer := 4;
  c_expected_pairs   constant integer := 2;

  v_members   uuid[];
  v_pairs     uuid[];
  v_batches   uuid[];
  v_intros    uuid[];
  v_member    uuid;
  m           record;
  p           record;
  v_digest    text;
  v_wrong     integer;
  v_guards    integer := 0;
  v_demoted   integer := 0;
  v_batches_made integer := 0;
  v_queued_batch uuid;
  v_src       text;
  v_created   timestamptz;
  v_gen       timestamptz;
  v_recip_bid uuid;
  v_rows      integer;
BEGIN
  ---------------------------------------------------------------- derive id arrays FROM the manifest
  SELECT array_agg((x->>'member')::uuid  ORDER BY x->>'member') INTO v_members FROM jsonb_array_elements(v_manifest) x;
  SELECT array_agg((x->>'batch')::uuid   ORDER BY x->>'batch')  INTO v_batches FROM jsonb_array_elements(v_manifest) x;
  SELECT array_agg((x->>'pair')::uuid)   INTO v_pairs   FROM jsonb_array_elements(v_pair_manifest) x;
  SELECT array_agg(v) INTO v_intros FROM (
    SELECT (x->>'recip_intro')::uuid AS v FROM jsonb_array_elements(v_manifest) x
    UNION ALL SELECT (x->>'demote')::uuid FROM jsonb_array_elements(v_manifest) x
    UNION ALL SELECT (x->>'keep')::uuid   FROM jsonb_array_elements(v_manifest) x) s;

  IF array_length(v_members,1) <> c_expected_members OR array_length(v_pairs,1) <> c_expected_pairs
     OR array_length(v_intros,1) <> 12 THEN
    RAISE EXCEPTION 'ABORT guard 0: manifest is malformed';
  END IF;
  v_guards := v_guards + 1;

  ---------------------------------------------------------------- LOCK FIRST — tables, then members
  -- BOUNDED WAIT: abort with 55P03 rather than queueing behind another writer indefinitely.
  PERFORM set_config('lock_timeout', '5s', true);

  -- TABLE LOCKS, fixed alphabetical order, taken BEFORE the first verification query and held to
  -- commit. SHARE ROW EXCLUSIVE conflicts with ROW EXCLUSIVE, so every concurrent INSERT/UPDATE/
  -- DELETE on these tables blocks for the whole verify-then-write window; plain SELECT still runs.
  -- Required because expire_stale_reciprocal_pairs, createIntroRequest and accept-incoming all
  -- write these tables WITHOUT taking the advisory key (see the header).
  LOCK TABLE public.intro_requests         IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.member_pairs           IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.recommendation_batches IN SHARE ROW EXCLUSIVE MODE;

  -- Advisory locks as well: same key and ordering discipline as the capacity RPCs, so this script is
  -- also ordered against them on the key they use. Taking locks is not a mutation.
  FOREACH v_member IN ARRAY (SELECT array_agg(u ORDER BY u) FROM unnest(v_members) u) LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_member::text, 0));
  END LOOP;

  ---------------------------------------------------------------- guard 1: every id still exists
  IF (SELECT count(*) FROM public.profiles WHERE id = ANY(v_members)) <> c_expected_members THEN
    RAISE EXCEPTION 'ABORT guard 1a: an expected member profile is missing';
  END IF;
  IF (SELECT count(*) FROM public.member_pairs WHERE id = ANY(v_pairs)) <> c_expected_pairs THEN
    RAISE EXCEPTION 'ABORT guard 1b: an expected member_pair is missing';
  END IF;
  IF (SELECT count(*) FROM public.recommendation_batches WHERE batch_id = ANY(v_batches)) <> c_expected_members THEN
    RAISE EXCEPTION 'ABORT guard 1c: an expected recommendation_batch is missing';
  END IF;
  IF (SELECT count(*) FROM public.intro_requests WHERE id = ANY(v_intros)) <> 12 THEN
    RAISE EXCEPTION 'ABORT guard 1d: an expected intro_request is missing';
  END IF;
  v_guards := v_guards + 1;

  ---------------------------------------------------------------- guard 2: no unexpected member
  -- The live over-capacity population must be EXACTLY the manifest. A different set of four members
  -- with the same shape aborts here; it is never substituted in.
  IF EXISTS (
    SELECT requester_id FROM public.intro_requests WHERE status = 'suggested'
    GROUP BY requester_id HAVING count(*) > c_max_visible
    EXCEPT SELECT unnest(v_members)
  ) THEN
    RAISE EXCEPTION 'ABORT guard 2a: an over-capacity member outside the approved manifest exists';
  END IF;
  IF EXISTS (
    SELECT unnest(v_members)
    EXCEPT SELECT requester_id FROM public.intro_requests WHERE status = 'suggested'
           GROUP BY requester_id HAVING count(*) > c_max_visible
  ) THEN
    RAISE EXCEPTION 'ABORT guard 2b: a manifest member is no longer over capacity';
  END IF;
  v_guards := v_guards + 1;

  ---------------------------------------------------------------- per-member guards 3, 5, 6, 7, 8, 9, 10
  FOR m IN SELECT * FROM jsonb_to_recordset(v_manifest) AS t(
             member uuid, pair uuid, counterpart uuid, recip_intro uuid, batch uuid,
             batch_source text, batch_state text, recip_batch_id uuid,
             demote uuid, demote_target uuid, keep uuid, keep_target uuid,
             admin_created_at timestamptz)
  LOOP
    -- guard 3: exactly three visible = one reciprocal + two admin-batch
    IF (SELECT count(*) FROM public.intro_requests
         WHERE requester_id = m.member AND status = 'suggested') <> 3 THEN
      RAISE EXCEPTION 'ABORT guard 3a: a manifest member no longer holds exactly 3 visible cards';
    END IF;
    IF (SELECT count(*) FROM public.intro_requests
         WHERE requester_id = m.member AND status='suggested' AND pair_id IS NOT NULL) <> 1 THEN
      RAISE EXCEPTION 'ABORT guard 3b: a manifest member does not hold exactly 1 reciprocal card';
    END IF;
    IF (SELECT count(*) FROM public.intro_requests
         WHERE requester_id = m.member AND status='suggested' AND batch_id IS NOT NULL) <> 2 THEN
      RAISE EXCEPTION 'ABORT guard 3c: a manifest member does not hold exactly 2 admin-batch cards';
    END IF;

    -- the reciprocal card is the expected row, on the expected pair, to the expected counterpart
    IF NOT EXISTS (
      SELECT 1 FROM public.intro_requests
      WHERE id = m.recip_intro AND requester_id = m.member AND target_user_id = m.counterpart
        AND pair_id = m.pair AND status = 'suggested' AND batch_id IS NULL
    ) THEN
      RAISE EXCEPTION 'ABORT guard 3d: the expected reciprocal card no longer matches the manifest';
    END IF;

    -- guard 5: each expected admin card belongs to that member AS REQUESTER, to the expected target
    IF NOT EXISTS (SELECT 1 FROM public.intro_requests
                    WHERE id = m.demote AND requester_id = m.member
                      AND target_user_id = m.demote_target AND status = 'suggested') THEN
      RAISE EXCEPTION 'ABORT guard 5a: the demotion card is not this member''s suggested card';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.intro_requests
                    WHERE id = m.keep AND requester_id = m.member
                      AND target_user_id = m.keep_target AND status = 'suggested') THEN
      RAISE EXCEPTION 'ABORT guard 5b: the retained card is not this member''s suggested card';
    END IF;

    -- guard 6: both admin cards belong to the expected active batch, and are the ONLY two
    IF (SELECT count(*) FROM public.intro_requests
         WHERE requester_id = m.member AND status='suggested' AND batch_id = m.batch) <> 2 THEN
      RAISE EXCEPTION 'ABORT guard 6a: the expected batch does not hold exactly this member''s 2 visible cards';
    END IF;
    IF EXISTS (SELECT 1 FROM public.intro_requests
                WHERE id IN (m.demote, m.keep) AND batch_id IS DISTINCT FROM m.batch) THEN
      RAISE EXCEPTION 'ABORT guard 6b: an expected admin card is not in the expected batch';
    END IF;

    -- guard 7: the batch itself matches member, state, source and reciprocal_batch_id
    IF NOT EXISTS (
      SELECT 1 FROM public.recommendation_batches
      WHERE batch_id = m.batch AND member_id = m.member
        AND state = m.batch_state AND batch_source = m.batch_source
        AND reciprocal_batch_id IS NOT DISTINCT FROM m.recip_batch_id
    ) THEN
      RAISE EXCEPTION 'ABORT guard 7: the expected batch no longer matches owner/state/source/reciprocal_batch_id';
    END IF;

    -- guard 8: no expressed interest against any of this member's visible targets, and no status drift
    IF EXISTS (
      SELECT 1 FROM public.intro_requests e
      WHERE e.requester_id = m.member
        AND e.status IN ('pending','accepted','accepted_pending_payment','admin_pending','approved')
        AND e.target_user_id IN (SELECT s.target_user_id FROM public.intro_requests s
                                  WHERE s.requester_id = m.member AND s.status = 'suggested')
    ) THEN
      RAISE EXCEPTION 'ABORT guard 8a: interest has been expressed on a manifest card since the preflight';
    END IF;
    IF EXISTS (SELECT 1 FROM public.intro_requests
                WHERE id IN (m.recip_intro, m.demote, m.keep) AND status <> 'suggested') THEN
      RAISE EXCEPTION 'ABORT guard 8b: a manifest card has moved to another status';
    END IF;

    -- guard 9: the demotion card is STILL the deterministic latest by (created_at DESC, id DESC)
    IF (SELECT ir.id FROM public.intro_requests ir
         WHERE ir.requester_id = m.member AND ir.status='suggested' AND ir.batch_id IS NOT NULL
         ORDER BY ir.created_at DESC, ir.id DESC LIMIT 1) <> m.demote THEN
      RAISE EXCEPTION 'ABORT guard 9: the deterministic demotion target has changed';
    END IF;

    -- guard 10: no reservations and no queued batch for this member
    IF (SELECT count(*) FROM public.intro_requests
         WHERE requester_id = m.member AND status = 'queued') <> 0 THEN
      RAISE EXCEPTION 'ABORT guard 10a: a manifest member already holds reservations';
    END IF;
    IF (SELECT count(*) FROM public.recommendation_batches
         WHERE member_id = m.member AND state = 'queued') <> 0 THEN
      RAISE EXCEPTION 'ABORT guard 10b: a manifest member already has a queued batch';
    END IF;
  END LOOP;
  v_guards := v_guards + 8;

  ---------------------------------------------------------------- guard 4: pair structure, both directions
  FOR p IN SELECT * FROM jsonb_to_recordset(v_pair_manifest) AS t(
             pair uuid, user_a uuid, user_b uuid, a_to_b uuid, b_to_a uuid,
             source text, status text)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.member_pairs
                    WHERE id = p.pair AND user_a_id = p.user_a AND user_b_id = p.user_b
                      AND source = p.source AND status = p.status) THEN
      RAISE EXCEPTION 'ABORT guard 4a: a manifest pair no longer matches its participants/source/status';
    END IF;
    IF (SELECT count(*) FROM public.intro_requests
         WHERE pair_id = p.pair AND status = 'suggested') <> 2 THEN
      RAISE EXCEPTION 'ABORT guard 4b: a manifest pair does not have exactly 2 visible sides';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.intro_requests
                    WHERE id = p.a_to_b AND pair_id = p.pair
                      AND requester_id = p.user_a AND target_user_id = p.user_b
                      AND status='suggested') THEN
      RAISE EXCEPTION 'ABORT guard 4c: the A->B direction of a manifest pair no longer matches';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.intro_requests
                    WHERE id = p.b_to_a AND pair_id = p.pair
                      AND requester_id = p.user_b AND target_user_id = p.user_a
                      AND status='suggested') THEN
      RAISE EXCEPTION 'ABORT guard 4d: the B->A direction of a manifest pair no longer matches';
    END IF;
    -- the requester/target SETS must be exactly {user_a, user_b}
    IF EXISTS (SELECT 1 FROM public.intro_requests
                WHERE pair_id = p.pair AND status='suggested'
                  AND (requester_id NOT IN (p.user_a, p.user_b)
                    OR target_user_id NOT IN (p.user_a, p.user_b))) THEN
      RAISE EXCEPTION 'ABORT guard 4e: a manifest pair involves a participant outside member_pairs';
    END IF;
  END LOOP;
  v_guards := v_guards + 1;

  ---------------------------------------------------------------- guard 11: capacity invariants hold
  IF EXISTS (SELECT 1 FROM public.intro_requests WHERE status='queued'
             GROUP BY requester_id HAVING count(*) > c_max_reserved) THEN
    RAISE EXCEPTION 'ABORT guard 11a: some member already exceeds the reserved cap';
  END IF;
  IF EXISTS (SELECT 1 FROM public.recommendation_batches WHERE state='active'
             GROUP BY member_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'ABORT guard 11b: some member has more than one active batch';
  END IF;
  IF EXISTS (SELECT 1 FROM public.recommendation_batches WHERE state='queued'
             GROUP BY member_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'ABORT guard 11c: some member has more than one queued batch';
  END IF;
  v_guards := v_guards + 1;

  ---------------------------------------------------------------- guard 12: manifest digest
  -- Recomputed exactly as the preflight computed it, but over the MANIFEST members only.
  SELECT md5(string_agg(t, '|' ORDER BY t)) INTO v_digest FROM (
    SELECT ir.requester_id::text || ':' || ir.id::text || ':' || ir.pair_id::text AS t
      FROM public.intro_requests ir
     WHERE ir.requester_id = ANY(v_members) AND ir.status='suggested' AND ir.pair_id IS NOT NULL
    UNION ALL
    SELECT r.requester_id::text || ':' || r.id::text || ':' || r.rnk::text FROM (
      SELECT ir.requester_id, ir.id,
             row_number() OVER (PARTITION BY ir.requester_id
                                ORDER BY ir.created_at DESC, ir.id DESC) AS rnk
        FROM public.intro_requests ir
       WHERE ir.requester_id = ANY(v_members) AND ir.status='suggested' AND ir.batch_id IS NOT NULL) r
    UNION ALL
    SELECT b.member_id::text || ':' || b.batch_id::text
      FROM public.recommendation_batches b
     WHERE b.member_id = ANY(v_members) AND b.state='active'
  ) s;
  IF v_digest IS DISTINCT FROM v_expected_digest THEN
    RAISE EXCEPTION 'ABORT guard 12: the live manifest digest does not match the approved capture';
  END IF;
  v_guards := v_guards + 1;

  ---------------------------------------------------------------- guard 13: baseline is unchanged
  SELECT count(*) INTO v_wrong
  FROM public.recommendation_batches b
  JOIN public.intro_requests i ON i.batch_id = b.batch_id
  WHERE (b.state='active' AND i.status <> 'suggested')
     OR (b.state='queued' AND i.status <> 'queued');
  IF v_wrong <> v_baseline_wrong_status THEN
    RAISE EXCEPTION 'ABORT guard 13: pre-existing inconsistent-row count is not the captured baseline';
  END IF;
  v_guards := v_guards + 1;

  ---------------------------------------------------------------- guard 14: baseline is DISJOINT
  -- None of those pre-existing rows may involve a manifest member, batch, pair or intro_request.
  IF EXISTS (
    SELECT 1
    FROM public.recommendation_batches b
    JOIN public.intro_requests i ON i.batch_id = b.batch_id
    WHERE ((b.state='active' AND i.status <> 'suggested')
        OR (b.state='queued' AND i.status <> 'queued'))
      AND (b.member_id = ANY(v_members)
        OR i.requester_id = ANY(v_members)
        OR b.batch_id = ANY(v_batches)
        OR i.batch_id = ANY(v_batches)
        OR i.id = ANY(v_intros)
        OR i.pair_id = ANY(v_pairs))
  ) THEN
    RAISE EXCEPTION 'ABORT guard 14: a pre-existing inconsistent row overlaps the approved manifest';
  END IF;
  v_guards := v_guards + 1;

  ---------------------------------------------------------------- ██ THE GATE ██
  IF NOT v_apply THEN
    RAISE NOTICE 'PREFLIGHT OK - % guard groups passed against the approved manifest.', v_guards;
    RAISE NOTICE 'NO CHANGES MADE. v_apply is false. Edit it to true to apply.';
    RETURN;   -- returns BEFORE the first write; nothing below has executed
  END IF;

  ---------------------------------------------------------------- the repair (only when applying)
  FOR m IN SELECT * FROM jsonb_to_recordset(v_manifest) AS t(
             member uuid, pair uuid, counterpart uuid, recip_intro uuid, batch uuid,
             batch_source text, batch_state text, recip_batch_id uuid,
             demote uuid, demote_target uuid, keep uuid, keep_target uuid,
             admin_created_at timestamptz)
  LOOP
    SELECT b.batch_source, b.created_at, b.generated_at, b.reciprocal_batch_id
      INTO v_src, v_created, v_gen, v_recip_bid
      FROM public.recommendation_batches b WHERE b.batch_id = m.batch;

    -- A batch's rows must all share its state, so the demoted row moves into a NEW queued batch
    -- carrying the original batch's provenance and timestamps. Guard 10b proved none exists yet.
    -- reciprocal_batch_id is PRESERVED, not nulled: it is the admin introduction_batches run this
    -- card came from, and promote_queued_rows copies it the same way when it splits a batch.
    v_queued_batch := gen_random_uuid();
    INSERT INTO public.recommendation_batches
      (batch_id, member_id, batch_source, state, reciprocal_batch_id,
       created_at, generated_at, displayed_at, completed_at)
    VALUES (v_queued_batch, m.member, v_src, 'queued', v_recip_bid, v_created, v_gen, NULL, NULL);
    v_batches_made := v_batches_made + 1;

    -- DEMOTE, NEVER DELETE. status and batch_id only; pair_id, match_reason, created_at and the
    -- reciprocal card are all left untouched.
    --
    -- THE PREDICATE CARRIES THE WHOLE EXPECTED PRE-STATE, not just the id. Under concurrency the
    -- guards above establish a fact and this statement acts on it; making the WHERE clause repeat
    -- every one of those facts means the write itself re-checks them atomically. If ANYTHING moved
    -- between verification and here, zero rows match and the exact-one assertion aborts everything.
    UPDATE public.intro_requests
       SET status = 'queued', batch_id = v_queued_batch, updated_at = now()
     WHERE id             = m.demote
       AND requester_id   = m.member
       AND target_user_id = m.demote_target
       AND status         = 'suggested'
       AND batch_id       = m.batch
       AND pair_id IS NULL                       -- an admin card never belongs to a pair
       AND created_at     = m.admin_created_at;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'ABORT: demotion matched % rows, expected exactly 1 - pre-state changed', v_rows;
    END IF;
    v_demoted := v_demoted + 1;
  END LOOP;

  IF v_demoted <> c_expected_members OR v_batches_made <> c_expected_members THEN
    RAISE EXCEPTION 'ABORT: expected % demotions and % new queued batches, performed % and %',
      c_expected_members, c_expected_members, v_demoted, v_batches_made;
  END IF;

  ---------------------------------------------------------------- postconditions, in-transaction
  IF EXISTS (SELECT 1 FROM public.intro_requests WHERE status='suggested'
             GROUP BY requester_id HAVING count(*) > c_max_visible) THEN
    RAISE EXCEPTION 'ABORT post 1: a member still exceeds the visible cap';
  END IF;
  IF EXISTS (SELECT 1 FROM public.intro_requests WHERE status='queued'
             GROUP BY requester_id HAVING count(*) > c_max_reserved) THEN
    RAISE EXCEPTION 'ABORT post 2: a member exceeds the reserved cap';
  END IF;
  IF EXISTS (SELECT 1 FROM public.recommendation_batches WHERE state='active'
             GROUP BY member_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'ABORT post 3: a member has more than one active batch';
  END IF;
  IF EXISTS (SELECT 1 FROM public.recommendation_batches WHERE state='queued'
             GROUP BY member_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'ABORT post 4: a member has more than one queued batch';
  END IF;
  -- every manifest member: exactly 2 visible, exactly 1 reserved, reciprocal still visible
  IF (SELECT count(*) FROM public.intro_requests
       WHERE requester_id = ANY(v_members) AND status='suggested') <> 8 THEN
    RAISE EXCEPTION 'ABORT post 5: manifest members do not hold exactly 8 visible cards in total';
  END IF;
  IF (SELECT count(*) FROM public.intro_requests
       WHERE requester_id = ANY(v_members) AND status='queued') <> 4 THEN
    RAISE EXCEPTION 'ABORT post 6: manifest members do not hold exactly 4 reserved cards in total';
  END IF;
  IF (SELECT count(*) FROM public.intro_requests
       WHERE id = ANY(v_intros) AND status='suggested') <> 8 THEN
    RAISE EXCEPTION 'ABORT post 7: the wrong number of manifest cards remain visible';
  END IF;
  IF EXISTS (SELECT 1 FROM public.intro_requests
              WHERE pair_id = ANY(v_pairs) AND status='suggested'
              GROUP BY pair_id HAVING count(*) <> 2) THEN
    RAISE EXCEPTION 'ABORT post 8: a reciprocal pair lost a visible side';
  END IF;
  -- no batch may mix statuses AMONG THE BATCHES THIS SCRIPT TOUCHED
  IF EXISTS (
    SELECT 1 FROM public.recommendation_batches b
    JOIN public.intro_requests i ON i.batch_id = b.batch_id
    WHERE b.member_id = ANY(v_members)
      AND ((b.state='active' AND i.status <> 'suggested')
        OR (b.state='queued' AND i.status <> 'queued'))
  ) THEN
    RAISE EXCEPTION 'ABORT post 9: a batch belonging to a manifest member holds wrong-status rows';
  END IF;
  -- the pre-existing, out-of-scope inconsistencies are exactly as they were: not fixed, not worsened
  SELECT count(*) INTO v_wrong
  FROM public.recommendation_batches b
  JOIN public.intro_requests i ON i.batch_id = b.batch_id
  WHERE (b.state='active' AND i.status <> 'suggested')
     OR (b.state='queued' AND i.status <> 'queued');
  IF v_wrong <> v_baseline_wrong_status THEN
    RAISE EXCEPTION 'ABORT post 10: the unrelated inconsistent-row count changed';
  END IF;

  RAISE NOTICE 'APPLIED - % cards demoted, % queued batches created, all postconditions hold.',
    v_demoted, v_batches_made;
  RAISE NOTICE 'Unrelated pre-existing inconsistent rows unchanged at %.', v_wrong;
END $$;


-- ═════ SECTION C — POST-CHECK (read-only; always runs; aggregate only) ══════════════════════════
--
-- Before applying, row 1 reads 4 and row 7 reads 4. After applying, rows 1-6 must be 0 and row 7
-- must be 0 as well; row 8 must remain 6 either way.

SELECT 'members over visible cap' AS check_name, count(*) AS value
  FROM (SELECT requester_id FROM public.intro_requests WHERE status='suggested'
         GROUP BY 1 HAVING count(*) > 2) x
UNION ALL SELECT 'members over reserved cap', count(*)
  FROM (SELECT requester_id FROM public.intro_requests WHERE status='queued'
         GROUP BY 1 HAVING count(*) > 2) x
UNION ALL SELECT 'members with >1 active batch', count(*)
  FROM (SELECT member_id FROM public.recommendation_batches WHERE state='active'
         GROUP BY 1 HAVING count(*) > 1) x
UNION ALL SELECT 'members with >1 queued batch', count(*)
  FROM (SELECT member_id FROM public.recommendation_batches WHERE state='queued'
         GROUP BY 1 HAVING count(*) > 1) x
UNION ALL SELECT 'reciprocal pairs missing a visible side', count(*)
  FROM (SELECT pair_id FROM public.intro_requests WHERE pair_id IS NOT NULL AND status='suggested'
         GROUP BY 1 HAVING count(*) <> 2) x
UNION ALL SELECT 'manifest-member batches with wrong-status rows', count(*)
  FROM public.recommendation_batches b JOIN public.intro_requests i ON i.batch_id = b.batch_id
 WHERE b.member_id IN ('9738c747-c00e-4588-a4fc-1b74dcfd85e6','a8111428-6825-49c3-a2a0-419cd8b11b52',
                       'd11d1c98-e016-497f-9308-e5a4f3caa146','d5a385d5-5526-4c8e-b17b-74a371b7fd6d')
   AND ((b.state='active' AND i.status <> 'suggested') OR (b.state='queued' AND i.status <> 'queued'))
UNION ALL SELECT 'manifest members still over visible cap', count(*)
  FROM (SELECT requester_id FROM public.intro_requests
         WHERE status='suggested'
           AND requester_id IN ('9738c747-c00e-4588-a4fc-1b74dcfd85e6','a8111428-6825-49c3-a2a0-419cd8b11b52',
                                'd11d1c98-e016-497f-9308-e5a4f3caa146','d5a385d5-5526-4c8e-b17b-74a371b7fd6d')
         GROUP BY 1 HAVING count(*) > 2) x
UNION ALL SELECT 'unrelated pre-existing wrong-status rows (baseline 6, must not change)', count(*)
  FROM public.recommendation_batches b JOIN public.intro_requests i ON i.batch_id = b.batch_id
 WHERE (b.state='active' AND i.status <> 'suggested') OR (b.state='queued' AND i.status <> 'queued');
