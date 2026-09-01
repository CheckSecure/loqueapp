-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- RUN LOG
--   Authored:  2026-08-31
--   Status:    SUPERSEDED BY THE TWO BLOCK FILES. This is the general form, kept as the record of
--              how the affected set was identified. Section A (read-only) was run to produce the
--              list; Section B was NOT applied, because the six affected rows split into two
--              groups needing different treatment — see repair_block1 and repair_block2.
--   Re-run:    Section A should now return ZERO rows. A non-empty result means either a new case
--              appeared or one of the blocks did not complete.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- ROOT CAUSE, fixed in 3796dc8: the referral credit hook lived inline in POST /api/profile/complete
-- and never ran for members who finished onboarding through completeOnboarding in app/actions.ts —
-- the other path that sets profile_complete. It is now a shared helper called by both.
-- Related: c5fe0b6 (award notification), 5d11e64 (the award write was not error-checked).
--
-- REPAIR — referrers never credited because the hook only existed on one completion path.
--
-- Cause (fixed in 3796dc8): two paths set profiles.profile_complete = true, and the referral credit
-- hook lived inline in only one of them. Members who finished through OnboardingForm reached
-- completeOnboarding, which never ran it. Their referral stayed at 'invited' and nothing logged a
-- failure, because nothing was attempted.
--
-- This repair does what the hook would have done: mark the referral activated, add 1 credit to the
-- referrer's PURCHASED bucket, stamp awarded_credit, and notify them.
--
-- RUN SECTION A FIRST. It writes nothing. Only set v_apply := true in Section B once the list in A
-- is what you expect.

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION A — DRY RUN. Read-only. Who is affected and what each would receive.
-- ─────────────────────────────────────────────────────────────────────────────
WITH affected AS (
  SELECT
    r.id                                   AS referral_id,
    r.referrer_user_id,
    w.full_name                            AS nominee,
    w.email                                AS nominee_email,
    np.id                                  AS nominee_profile_id,
    -- When the nominee actually finished. welcome_sent_at is stamped by sendAdminWelcome, which
    -- fires on BOTH completion paths, so it is the one timestamp present for everyone.
    -- intro_guidance_enrolled_at is preferred where it exists but is NULL for anyone who completed
    -- before migration 084. Backdating to the real completion keeps the monthly cap honest: these
    -- awards belong to the months they were earned, not to today.
    COALESCE(np.intro_guidance_enrolled_at, np.welcome_sent_at, np.created_at) AS completed_at
  FROM public.referrals r
  JOIN public.waitlist w  ON w.id = r.waitlist_id
  JOIN public.profiles np ON lower(np.email) = lower(w.email)
  WHERE r.status = 'invited'
    AND np.profile_complete IS TRUE
    AND r.awarded_credit IS NOT TRUE
)
SELECT
  a.nominee,
  a.nominee_email,
  a.completed_at,
  rp.full_name                             AS referrer,
  rp.email                                 AS referrer_email,
  rp.account_status                        AS referrer_status,
  COALESCE(mc.free_credits, 0)             AS referrer_included,
  COALESCE(mc.premium_credits, 0)          AS referrer_purchased,
  COALESCE(mc.balance, 0)                  AS referrer_balance,
  COALESCE(mc.balance, 0) + 1              AS balance_after,
  -- How many of these would land on the same referrer in the same calendar month. The live hook
  -- caps awards at 5 per referrer per month; anything above that here would be refused.
  count(*) OVER (
    PARTITION BY a.referrer_user_id, date_trunc('month', a.completed_at)
  )                                        AS same_referrer_same_month,
  CASE
    WHEN rp.account_status IS DISTINCT FROM 'active'
      THEN 'SKIP — referrer not active (hook would withhold the credit too)'
    WHEN mc.user_id IS NULL
      THEN 'SKIP — referrer has no meeting_credits row'
    WHEN COALESCE(mc.balance, 0) + 1 > 50
      THEN 'SKIP — would breach the combined 50-credit cap (089 trigger refuses)'
    WHEN count(*) OVER (PARTITION BY a.referrer_user_id, date_trunc('month', a.completed_at)) > 5
      THEN 'REVIEW — more than 5 for this referrer in one month'
    ELSE 'WOULD CREDIT +1'
  END                                      AS verdict
FROM affected a
LEFT JOIN public.profiles rp        ON rp.id = a.referrer_user_id
LEFT JOIN public.meeting_credits mc ON mc.user_id = a.referrer_user_id
ORDER BY referrer, a.completed_at;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION B — APPLY. Set v_apply := true only after reviewing Section A.
-- ─────────────────────────────────────────────────────────────────────────────
DO $repair$
DECLARE
  v_apply    boolean := false;   -- ← flip to true to write
  v_row      record;
  v_credited int := 0;
  v_skipped  int := 0;
  v_first    text;
BEGIN
  IF NOT v_apply THEN
    RAISE NOTICE 'DRY RUN — v_apply is false. Nothing was written.';
  END IF;

  FOR v_row IN
    SELECT
      r.id AS referral_id, r.referrer_user_id,
      w.full_name AS nominee, np.id AS nominee_profile_id,
      COALESCE(np.intro_guidance_enrolled_at, np.welcome_sent_at, np.created_at) AS completed_at,
      rp.account_status, mc.user_id AS credits_row,
      COALESCE(mc.free_credits,0) AS free_c, COALESCE(mc.premium_credits,0) AS prem_c,
      COALESCE(mc.balance,0) AS bal, COALESCE(mc.lifetime_earned,0) AS life
    FROM public.referrals r
    JOIN public.waitlist w  ON w.id = r.waitlist_id
    JOIN public.profiles np ON lower(np.email) = lower(w.email)
    LEFT JOIN public.profiles rp        ON rp.id = r.referrer_user_id
    LEFT JOIN public.meeting_credits mc ON mc.user_id = r.referrer_user_id
    WHERE r.status = 'invited'
      AND np.profile_complete IS TRUE
      AND r.awarded_credit IS NOT TRUE
    ORDER BY r.id
  LOOP
    -- The relationship is real regardless of whether the credit can be paid, so activation is
    -- recorded for every row — exactly as the live hook does before deciding about the credit.
    IF v_apply THEN
      UPDATE public.referrals
      SET status = 'activated', activated_at = COALESCE(activated_at, v_row.completed_at)
      WHERE id = v_row.referral_id;
    END IF;

    IF v_row.account_status IS DISTINCT FROM 'active' THEN
      RAISE NOTICE 'skip (referrer inactive): referral %', v_row.referral_id;
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;
    IF v_row.credits_row IS NULL THEN
      RAISE NOTICE 'skip (no credits row): referral %', v_row.referral_id;
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;
    IF v_row.bal + 1 > 50 THEN
      RAISE NOTICE 'skip (combined cap): referral %', v_row.referral_id;
      v_skipped := v_skipped + 1; CONTINUE;
    END IF;

    IF v_apply THEN
      -- PURCHASED bucket, matching the live hook: an earned reward must not compete with the
      -- monthly refill against the 20-credit included ceiling.
      UPDATE public.meeting_credits
      SET premium_credits = v_row.prem_c + 1,
          balance         = v_row.free_c + v_row.prem_c + 1,
          lifetime_earned = v_row.life + 1
      WHERE user_id = v_row.referrer_user_id;

      -- awarded_at is BACKDATED to the nominee's completion so the per-month cap reflects when
      -- each credit was actually earned rather than bunching all of them into today.
      UPDATE public.referrals
      SET awarded_credit = true, awarded_at = v_row.completed_at
      WHERE id = v_row.referral_id;

      -- Same notification the live path sends. dedupeKey is the referral id, and migration 006's
      -- unique index makes this a no-op if the live hook ever notified for the same referral.
      v_first := split_part(btrim(COALESCE(v_row.nominee, '')), ' ', 1);
      INSERT INTO public.notifications (user_id, type, title, body, link, data, created_at)
      VALUES (
        v_row.referrer_user_id,
        'referral_credit_awarded',
        CASE WHEN v_first <> '' THEN v_first || ' just joined — you earned a credit'
             ELSE 'Someone you recommended just joined' END,
        CASE WHEN v_first <> '' THEN 'Thanks for recommending ' || v_first ||
               '. Your credit has been added, and we''ll introduce you if it''s a fit.'
             ELSE 'Your credit has been added, and we''ll introduce you if it''s a fit.' END,
        '/dashboard/network',
        jsonb_build_object('dedupeKey', v_row.referral_id::text,
                           'referralId', v_row.referral_id::text,
                           'joinedUserId', v_row.nominee_profile_id::text,
                           'source', 'repair_uncredited_referrals'),
        now()
      )
      ON CONFLICT DO NOTHING;
    END IF;

    v_credited := v_credited + 1;
    RAISE NOTICE '% referral % → referrer % (+1 purchased)',
      CASE WHEN v_apply THEN 'CREDITED' ELSE 'would credit' END,
      v_row.referral_id, v_row.referrer_user_id;
  END LOOP;

  RAISE NOTICE '%: % credited, % skipped',
    CASE WHEN v_apply THEN 'APPLIED' ELSE 'DRY RUN' END, v_credited, v_skipped;

  IF NOT v_apply THEN
    RAISE EXCEPTION 'DRY RUN — rolling back deliberately. Set v_apply := true to commit.';
  END IF;
END
$repair$;
