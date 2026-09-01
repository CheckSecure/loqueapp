-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- RUN LOG
--   Authored:  2026-08-31
--   Run:       against production by the operator, per their report, BEFORE block 1. Exact
--              timestamp not captured here — amend this line if an audit needs it.
--   Scope:     3 referrals where james.kahrs@cbh.com was the referrer, guarded by v_expected := 3.
--   Effect:    flags only — activated, awarded_credit = true, backdated awarded_at.
--              NO credits added and NO notifications sent: he had already been credited by hand.
--   Why first: until awarded_credit is true these rows still match the repair predicate, so any
--              earlier run of the general repair would have paid him a second time.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- ROOT CAUSE, fixed in 3796dc8: the referral credit hook lived inline in POST /api/profile/complete
-- and never ran for members who finished onboarding through completeOnboarding in app/actions.ts —
-- the other path that sets profile_complete. It is now a shared helper called by both.
-- Related: c5fe0b6 (award notification), 5d11e64 (the award write was not error-checked).
--
-- BLOCK 2 — close out James Kahrs's 3 referrals WITHOUT paying again.
--
-- He was credited by hand before this repair existed. Left as they are, the rows still match the
-- repair's predicate (status='invited' AND awarded_credit IS NOT TRUE), so the next run would
-- credit him a second time.
--
-- Sets the flags that make the rows terminal — status='activated', awarded_credit=true, awarded_at
-- — and does NOTHING ELSE. No meeting_credits write. No notification: he already knows, and a
-- "you earned a credit" notice for a credit granted weeks ago by hand would be misleading.
--
-- ON THE "NOTE": public.referrals has no operator-note column. The only free-text field is
-- referral_note, which is the MEMBER's own reason for recommending someone and is rendered back to
-- him at /dashboard/referrals — overwriting it would destroy his text and change what he sees, so
-- this block does not touch it. See the options at the end of this file for a durable marker.
--
-- The exclusion itself is complete without any note: awarded_credit = true removes these rows from
-- every future run, because the repair filters on `awarded_credit IS NOT TRUE`.
BEGIN;

DO $block2$
DECLARE
  v_referrer uuid;
  v_expected int := 3;      -- ← the count you verified in Section A
  v_n        int := 0;
BEGIN
  -- Resolved by EMAIL only. A name match is too loose for a write that closes rows permanently.
  SELECT id INTO v_referrer FROM public.profiles
  WHERE lower(email) = 'james.kahrs@cbh.com';
  IF v_referrer IS NULL THEN RAISE EXCEPTION 'james.kahrs@cbh.com not found in profiles'; END IF;

  SELECT count(*) INTO v_n
  FROM public.referrals r
  JOIN public.waitlist w  ON w.id = r.waitlist_id
  JOIN public.profiles np ON lower(np.email) = lower(w.email)
  WHERE r.referrer_user_id = v_referrer
    AND r.status = 'invited' AND np.profile_complete IS TRUE AND r.awarded_credit IS NOT TRUE;

  IF v_n <> v_expected THEN
    RAISE EXCEPTION 'expected % rows for James, found % — review before running', v_expected, v_n;
  END IF;

  -- Flags only. Backdated to the nominee's completion for the same reason as Block 1: the awards
  -- belong to the months they were earned.
  UPDATE public.referrals r
  SET status = 'activated',
      activated_at = COALESCE(r.activated_at, sub.completed_at),
      awarded_credit = true,
      awarded_at = sub.completed_at
  FROM (
    SELECT r2.id,
           COALESCE(np.intro_guidance_enrolled_at, np.welcome_sent_at, np.created_at) AS completed_at
    FROM public.referrals r2
    JOIN public.waitlist w  ON w.id = r2.waitlist_id
    JOIN public.profiles np ON lower(np.email) = lower(w.email)
    WHERE r2.referrer_user_id = v_referrer
      AND r2.status = 'invited' AND np.profile_complete IS TRUE AND r2.awarded_credit IS NOT TRUE
  ) sub
  WHERE r.id = sub.id;

  RAISE NOTICE 'BLOCK 2 complete: % referrals closed for % — NO credits added, NO notifications', v_n, v_referrer;
END
$block2$;

COMMIT;


-- ── OPTIONAL: a durable note, if you want provenance beyond this file ────────────────────────
-- referrals has nowhere safe to record "granted manually". Two options, neither run by default:
--
--   1. Add a column (one migration, permanent home for operator provenance):
--        ALTER TABLE public.referrals ADD COLUMN IF NOT EXISTS repair_note text;
--        UPDATE public.referrals SET repair_note =
--          'credit granted manually before repair_uncredited_referrals; no credit added by repair'
--        WHERE id IN (...the 3 ids...);
--
--   2. Record it in credit_transactions, the existing ledger. NOT recommended here: that table
--      records credit MOVEMENTS, and James's movement was already written when you credited him
--      by hand. A second row risks a later audit reading it as two credits rather than one.
