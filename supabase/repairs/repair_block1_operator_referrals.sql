-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- RUN LOG
--   Authored:  2026-08-31
--   Run:       against production by the operator, per their report. Exact timestamp not captured
--              here — amend this line if an audit needs it.
--   Scope:     3 referrals where bizdev91@gmail.com was the referrer, guarded by v_expected := 3.
--   Effect:    each referral activated, +1 to the referrer's premium_credits, awarded_credit
--              stamped with a BACKDATED awarded_at, and one referral_credit_awarded notification
--              per referral.
--   Note:      those 3 nominations were submitted through the member form by the operator
--              themselves, not received from a member's recommendation. The credits are correct by
--              the system's rules; whether self-recruitment SHOULD earn a referral credit is a
--              separate policy question that was left open.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- ROOT CAUSE, fixed in 3796dc8: the referral credit hook lived inline in POST /api/profile/complete
-- and never ran for members who finished onboarding through completeOnboarding in app/actions.ts —
-- the other path that sets profile_complete. It is now a shared helper called by both.
-- Related: c5fe0b6 (award notification), 5d11e64 (the award write was not error-checked).
--
-- BLOCK 1 — credit the operator's own 3 uncredited referrals (bizdev91@gmail.com).
--
-- Same actions the live hook would have taken: activate, +1 to the PURCHASED bucket, stamp
-- awarded_credit with a BACKDATED awarded_at, notify. Scoped to ONE referrer by email.
--
-- Guarded: if the affected count is not exactly 3 it raises and rolls back, so a mis-scoped run
-- cannot quietly credit a wider set.
BEGIN;

DO $block1$
DECLARE
  v_referrer  uuid;
  v_expected  int := 3;      -- ← the count you verified in Section A
  v_row       record;
  v_n         int := 0;
  v_first     text;
BEGIN
  SELECT id INTO v_referrer FROM public.profiles WHERE lower(email) = 'bizdev91@gmail.com';
  IF v_referrer IS NULL THEN RAISE EXCEPTION 'referrer not found'; END IF;

  SELECT count(*) INTO v_n
  FROM public.referrals r
  JOIN public.waitlist w  ON w.id = r.waitlist_id
  JOIN public.profiles np ON lower(np.email) = lower(w.email)
  WHERE r.referrer_user_id = v_referrer
    AND r.status = 'invited' AND np.profile_complete IS TRUE AND r.awarded_credit IS NOT TRUE;

  IF v_n <> v_expected THEN
    RAISE EXCEPTION 'expected % affected rows, found % — review before running', v_expected, v_n;
  END IF;

  FOR v_row IN
    SELECT r.id AS referral_id, w.full_name AS nominee, np.id AS nominee_profile_id,
           COALESCE(np.intro_guidance_enrolled_at, np.welcome_sent_at, np.created_at) AS completed_at
    FROM public.referrals r
    JOIN public.waitlist w  ON w.id = r.waitlist_id
    JOIN public.profiles np ON lower(np.email) = lower(w.email)
    WHERE r.referrer_user_id = v_referrer
      AND r.status = 'invited' AND np.profile_complete IS TRUE AND r.awarded_credit IS NOT TRUE
    ORDER BY r.id
  LOOP
    UPDATE public.referrals
    SET status = 'activated',
        activated_at = COALESCE(activated_at, v_row.completed_at),
        awarded_credit = true,
        awarded_at = v_row.completed_at
    WHERE id = v_row.referral_id;

    -- PURCHASED bucket. The 089 trigger recomputes balance and enforces the combined 50 cap, so a
    -- breach raises here and rolls the whole block back rather than half-crediting.
    UPDATE public.meeting_credits
    SET premium_credits = COALESCE(premium_credits,0) + 1,
        balance         = COALESCE(free_credits,0) + COALESCE(premium_credits,0) + 1,
        lifetime_earned = COALESCE(lifetime_earned,0) + 1
    WHERE user_id = v_referrer;

    v_first := split_part(btrim(COALESCE(v_row.nominee, '')), ' ', 1);
    INSERT INTO public.notifications (user_id, type, title, body, link, data, created_at)
    VALUES (
      v_referrer, 'referral_credit_awarded',
      CASE WHEN v_first <> '' THEN v_first || ' just joined — you earned a credit'
           ELSE 'Someone you recommended just joined' END,
      CASE WHEN v_first <> '' THEN 'Thanks for recommending ' || v_first ||
             '. Your credit has been added, and we''ll introduce you if it''s a fit.'
           ELSE 'Your credit has been added, and we''ll introduce you if it''s a fit.' END,
      '/dashboard/network',
      jsonb_build_object('dedupeKey', v_row.referral_id::text,
                         'referralId', v_row.referral_id::text,
                         'joinedUserId', v_row.nominee_profile_id::text,
                         'source', 'repair_block1'),
      now()
    )
    ON CONFLICT DO NOTHING;

    RAISE NOTICE 'credited referral % (nominee %)', v_row.referral_id, v_row.nominee;
  END LOOP;

  RAISE NOTICE 'BLOCK 1 complete: % referrals credited to %', v_n, v_referrer;
END
$block1$;

COMMIT;
