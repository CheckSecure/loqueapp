-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- HISTORICAL CLEANUP — neutralise live cards whose target became unavailable. GATE IS FALSE.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- AS CHECKED IN, THIS FILE CHANGES NOTHING. It runs the whole cleanup, verifies it, prints exact
-- before/after counts, and then RAISES — which rolls every one of those writes back. Applying means
-- changing ONE literal, `v_apply`, from false to true, and nothing else.
--
-- WHY IT IS SEPARATE FROM MIGRATION 085. 085 corrects the predicate, which ends the stranding
-- immediately for every member without touching a row. This file only tidies the leftover rows so
-- they stop occupying visible capacity. Embedding it in the migration would make a schema change
-- and a bulk data rewrite the same irreversible event, which is exactly what "do not embed a
-- historical data backfill in the migration" forbids.
--
-- WHAT IT DOES, PER CARD: calls public.neutralize_unavailable_pair(card_id) — the single locked,
-- pair-consistent, advisory-locked neutraliser the application would use. It therefore:
--   • writes status 'expired' + resolution_reason 'system_pair_unavailable' — never 'passed',
--     never a member-authored reason, so no Pass or Interest signal is manufactured;
--   • closes BOTH directions of a reciprocal pair together, and marks member_pairs 'expired' only
--     when no 'suggested' row remains for that pair;
--   • REFUSES (and leaves untouched) any card that is matched, mutually pending, finalised, no
--     longer 'suggested', or whose target turns out to be available after all;
--   • discloses no one-sided interest: both rows get the same neutral status and nobody is told;
--   • creates no match, conversation, notification, email, credit or replacement card.
--
-- IT DOES NOT generate replacements. A member whose stale card is cleared simply becomes eligible
-- again and is considered by the next ordinary weekly run.
--
-- PREREQUISITE: migration 085 must be applied (this file calls a function 085 creates).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $cleanup$
DECLARE
  -- ─────────────────────────────────────────────────────────────────────────────────────────────
  -- THE OPERATOR GATE. false = dry run: everything below runs, is verified, and is then rolled
  -- back. Change ONLY this literal to apply.
  v_apply constant boolean := false;
  -- ─────────────────────────────────────────────────────────────────────────────────────────────

  r              record;
  v_before       bigint;
  v_before_unav  bigint;
  v_after        bigint;
  v_after_unav   bigint;
  v_released     bigint := 0;
  v_refused      bigint := 0;
  v_outcome      jsonb;
  v_reasons      jsonb;
  v_pairs_bad    bigint;
  v_member_bad   bigint;
  v_cap_before   bigint;
  v_cap_after    bigint;
  v_m0 bigint; v_m1 bigint; v_c0 bigint; v_c1 bigint; v_g0 bigint; v_g1 bigint;
  v_n0 bigint; v_n1 bigint; v_s0 bigint; v_s1 bigint;
BEGIN
  IF pg_catalog.to_regprocedure('public.neutralize_unavailable_pair(uuid)') IS NULL THEN
    RAISE EXCEPTION 'CLEANUP: migration 085 is not applied (neutralize_unavailable_pair absent).';
  END IF;

  -- ── PRE-COUNTS ──────────────────────────────────────────────────────────────────────────────
  SELECT count(*) INTO v_before FROM public.intro_requests WHERE status = 'suggested';
  SELECT count(*) INTO v_before_unav
    FROM public.intro_requests s
    LEFT JOIN public.profiles t ON t.id = s.target_user_id
   WHERE s.status = 'suggested'
     AND (t.id IS NULL OR t.account_status <> 'active' OR t.profile_complete IS NOT TRUE
          OR t.is_test_account IS TRUE OR t.matching_paused IS TRUE
          OR EXISTS (SELECT 1 FROM public.blocked_users bu
                      WHERE (bu.user_id = s.requester_id   AND bu.blocked_user_id = s.target_user_id)
                         OR (bu.user_id = s.target_user_id AND bu.blocked_user_id = s.requester_id)));

  -- VISIBLE CAPACITY, by the exact authority the four writers use.
  SELECT count(*) INTO v_cap_before FROM public.intro_requests
   WHERE status = 'suggested' AND capacity_released_at IS NULL;

  -- Everything that must NOT change. Counted before and compared after.
  SELECT count(*) INTO v_m0 FROM public.matches;
  SELECT count(*) INTO v_c0 FROM public.conversations;
  SELECT count(*) INTO v_g0 FROM public.messages;
  SELECT count(*) INTO v_n0 FROM public.notifications;
  SELECT count(*) INTO v_s0 FROM public.meeting_credits;

  RAISE NOTICE 'BEFORE — suggested: %, of which unavailable: %, visible capacity consumed: %',
    v_before, v_before_unav, v_cap_before;

  -- ── NEUTRALISE, one card at a time, through the audited function ────────────────────────────
  FOR r IN
    SELECT s.id
      FROM public.intro_requests s
      LEFT JOIN public.profiles t ON t.id = s.target_user_id
     WHERE s.status = 'suggested'
       AND (t.id IS NULL OR t.account_status <> 'active' OR t.profile_complete IS NOT TRUE
            OR t.is_test_account IS TRUE OR t.matching_paused IS TRUE
            OR EXISTS (SELECT 1 FROM public.blocked_users bu
                        WHERE (bu.user_id = s.requester_id   AND bu.blocked_user_id = s.target_user_id)
                           OR (bu.user_id = s.target_user_id AND bu.blocked_user_id = s.requester_id)))
     ORDER BY s.id
  LOOP
    v_outcome := public.neutralize_unavailable_pair(r.id);
    IF v_outcome ->> 'outcome' = 'released' THEN
      v_released := v_released + 1;
    ELSE
      -- A refusal is a correct outcome, not an error: matched / mutual_pending / finalized /
      -- not_actionable (a pair counterpart already closed by an earlier iteration) / target_available.
      v_refused := v_refused + 1;
    END IF;
  END LOOP;

  -- ── POST-COUNTS AND INVARIANTS ──────────────────────────────────────────────────────────────
  SELECT count(*) INTO v_after FROM public.intro_requests WHERE status = 'suggested';
  SELECT count(*) INTO v_after_unav
    FROM public.intro_requests s
    LEFT JOIN public.profiles t ON t.id = s.target_user_id
   WHERE s.status = 'suggested'
     AND (t.id IS NULL OR t.account_status <> 'active' OR t.profile_complete IS NOT TRUE
          OR t.is_test_account IS TRUE OR t.matching_paused IS TRUE
          OR EXISTS (SELECT 1 FROM public.blocked_users bu
                      WHERE (bu.user_id = s.requester_id   AND bu.blocked_user_id = s.target_user_id)
                         OR (bu.user_id = s.target_user_id AND bu.blocked_user_id = s.requester_id)));

  -- Every reason written by this run is the NEUTRAL one. Not one member verdict was manufactured.
  SELECT pg_catalog.jsonb_object_agg(COALESCE(resolution_reason,'(null)'), n) INTO v_reasons
    FROM (SELECT resolution_reason, count(*) AS n
            FROM public.intro_requests
           WHERE status = 'expired' AND updated_at >= now() - interval '1 minute'
           GROUP BY resolution_reason) x;

  -- PAIR CONSISTENCY: no pair may be left with exactly one side still 'suggested'.
  SELECT count(*) INTO v_pairs_bad FROM (
    SELECT pair_id FROM public.intro_requests
     WHERE pair_id IS NOT NULL AND status = 'suggested'
     GROUP BY pair_id HAVING count(*) = 1
       AND EXISTS (SELECT 1 FROM public.intro_requests o
                    WHERE o.pair_id = intro_requests.pair_id
                      AND o.status = 'expired'
                      AND o.resolution_reason = 'system_pair_unavailable')
  ) z;

  -- member_pairs must not still be 'active' with no live card at all.
  SELECT count(*) INTO v_member_bad
    FROM public.member_pairs mp
   WHERE mp.status = 'active'
     AND EXISTS (SELECT 1 FROM public.intro_requests x WHERE x.pair_id = mp.id
                   AND x.resolution_reason = 'system_pair_unavailable')
     AND NOT EXISTS (SELECT 1 FROM public.intro_requests y WHERE y.pair_id = mp.id AND y.status = 'suggested');

  SELECT count(*) INTO v_cap_after FROM public.intro_requests
   WHERE status = 'suggested' AND capacity_released_at IS NULL;
  SELECT count(*) INTO v_m1 FROM public.matches;
  SELECT count(*) INTO v_c1 FROM public.conversations;
  SELECT count(*) INTO v_g1 FROM public.messages;
  SELECT count(*) INTO v_n1 FROM public.notifications;
  SELECT count(*) INTO v_s1 FROM public.meeting_credits;

  RAISE NOTICE 'AFTER  — suggested: %, of which unavailable: %, visible capacity consumed: %',
    v_after, v_after_unav, v_cap_after;
  RAISE NOTICE 'CAPACITY RECOVERED: % slot(s)', v_cap_before - v_cap_after;
  RAISE NOTICE 'RELEASED: %, REFUSED (correctly left alone): %', v_released, v_refused;
  RAISE NOTICE 'REASONS WRITTEN: %', COALESCE(v_reasons::text, '{}');
  RAISE NOTICE 'HALF-CLOSED PAIRS: %   STALE ACTIVE member_pairs: %', v_pairs_bad, v_member_bad;

  IF v_pairs_bad > 0 THEN
    RAISE EXCEPTION 'CLEANUP ABORTED: % reciprocal pairs left half-closed.', v_pairs_bad;
  END IF;
  IF v_member_bad > 0 THEN
    RAISE EXCEPTION 'CLEANUP ABORTED: % member_pairs left ''active'' with no live card.', v_member_bad;
  END IF;
  IF EXISTS (SELECT 1 FROM public.intro_requests
              WHERE resolution_reason IN ('not_for_me','never_show','already_know')
                AND status = 'expired' AND updated_at >= now() - interval '1 minute') THEN
    RAISE EXCEPTION 'CLEANUP ABORTED: a member-authored reason was written by this run.';
  END IF;

  -- CAPACITY MUST HAVE BEEN RECOVERED, and by exactly the number of rows released. Anything else
  -- means a row was closed that was not consuming a slot, or one was missed.
  IF v_cap_before - v_cap_after <> v_released THEN
    RAISE EXCEPTION
      'CLEANUP ABORTED: % cards released but visible capacity fell by % (% -> %). '
      'Capacity recovery and release count must agree exactly.',
      v_released, v_cap_before - v_cap_after, v_cap_before, v_cap_after;
  END IF;
  IF v_after_unav <> 0 AND v_released > 0 THEN
    RAISE NOTICE 'NOTE: % unavailable rows remain — they were refused, not missed (matched / '
      'mutual_pending / finalized). Re-run after those resolve.', v_after_unav;
  END IF;

  -- NOTHING ELSE MOVED. No match, conversation, message, notification or credit row was created,
  -- destroyed, or otherwise counted differently by this run.
  IF v_m1 <> v_m0 OR v_c1 <> v_c0 OR v_g1 <> v_g0 OR v_n1 <> v_n0 OR v_s1 <> v_s0 THEN
    RAISE EXCEPTION
      'CLEANUP ABORTED: a side effect escaped. matches %->%, conversations %->%, messages %->%, '
      'notifications %->%, meeting_credits %->%.',
      v_m0, v_m1, v_c0, v_c1, v_g0, v_g1, v_n0, v_n1, v_s0, v_s1;
  END IF;

  IF NOT v_apply THEN
    RAISE EXCEPTION
      'DRY RUN COMPLETE — NOTHING WAS KEPT. % cards would be neutralised and % correctly refused; '
      'suggested rows would go % -> %, unavailable % -> %, and % visible slot(s) would be recovered. '
      'No match, conversation, message, notification or credit changed. This exception rolls all of '
      'it back. Set v_apply := true to apply.',
      v_released, v_refused, v_before, v_after, v_before_unav, v_after_unav, v_cap_before - v_cap_after;
  END IF;

  RAISE NOTICE 'CLEANUP APPLIED — % released, % refused, % visible slot(s) recovered.',
    v_released, v_refused, v_cap_before - v_cap_after;
END
$cleanup$;

-- Reachable ONLY when v_apply was true. With the gate false the block above raises, the transaction
-- is aborted, and PostgreSQL treats this as a ROLLBACK.
COMMIT;
