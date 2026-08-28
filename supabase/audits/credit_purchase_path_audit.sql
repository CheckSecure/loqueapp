-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PURCHASE-PATH AUDIT — READ-ONLY. ONE statement. AGGREGATE ONLY. NO identities, NO Stripe IDs.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Answers whether Stripe credit-pack purchases are being fulfilled exactly once, and how much
-- purchase headroom members would have under a combined cap of 50. It CHANGES NOTHING.
--
-- NO IDENTIFIERS OF ANY KIND. public.credit_grants stores stripe_event_id, stripe_session_id and
-- stripe_price_id. NONE of them is emitted — not even truncated, because a Stripe object id is a
-- payment identifier and a price id in aggregate output invites correlation with a member. Price
-- IDs are reduced to a DENSE RANK ordinal ('pack #1', 'pack #2'), which conveys distribution
-- without naming anything. Amounts are bucketed, never summed per member.
--
-- ─── WHAT THIS AUDIT CANNOT SEE ───────────────────────────────────────────────────────────────
-- credit_grants records only SUCCESSFUL fulfilments. There is no table of attempted, pending,
-- abandoned or expired Checkout sessions anywhere in this schema, and no reservation table. So:
--   • "paid but not credited" is NOT determinable here — the evidence lives in Stripe, not in this
--     database. Reported as unavailable.
--   • "credited without paid" IS partly determinable: every grant row carries a positive
--     amount_total, so a zero/negative amount would be an anomaly.
--   • abandoned/pending sessions are NOT determinable — no such rows exist to count.
-- Each is labelled rather than inferred.
WITH have AS (
  SELECT to_regclass('public.credit_grants')       IS NOT NULL AS has_grants,
         to_regclass('public.credit_transactions') IS NOT NULL AS has_tx,
         to_regclass('public.meeting_credits')     IS NOT NULL AS has_mc
),
grants AS (
  SELECT g.user_id, g.credits, g.amount_total, g.currency, g.created_at,
         g.stripe_price_id, g.stripe_event_id, g.stripe_session_id
  FROM public.credit_grants g WHERE (SELECT has_grants FROM have)
),
-- Price IDs → ordinals. The id itself never leaves this CTE.
packs AS (
  SELECT stripe_price_id, dense_rank() OVER (ORDER BY min(created_at), stripe_price_id) AS pack_no,
         min(credits) AS credits, count(*) AS purchases
  FROM grants GROUP BY stripe_price_id
),
per_member AS (
  SELECT user_id, count(*) AS purchases, sum(credits) AS credits_bought
  FROM grants GROUP BY user_id
),
mc AS (
  SELECT m.user_id,
         COALESCE(m.free_credits,0) AS free_credits,
         COALESCE(m.premium_credits,0) AS premium_credits,
         COALESCE(m.free_credits,0) + COALESCE(m.premium_credits,0) AS combined
  FROM public.meeting_credits m
  WHERE (SELECT has_mc FROM have)
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = m.user_id AND p.is_test_account IS NOT TRUE)
),
headroom AS (
  SELECT user_id, combined, GREATEST(50 - combined, 0) AS headroom_50 FROM mc
)
SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now(),
  'tables_present', (SELECT to_jsonb(h) FROM have h),
  'successful_purchases', CASE WHEN (SELECT has_grants FROM have) THEN jsonb_build_object(
      'total_grants',            (SELECT count(*) FROM grants),
      'distinct_members',        (SELECT count(*) FROM per_member),
      'grants_last_90d',         (SELECT count(*) FROM grants WHERE created_at >= now() - interval '90 days'),
      'total_credits_granted',   (SELECT COALESCE(sum(credits),0) FROM grants),
      'currencies',              COALESCE((SELECT jsonb_agg(DISTINCT currency) FROM grants), '[]'::jsonb),
      'by_pack_ordinal', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'pack', 'pack #' || pack_no, 'credits_per_pack', credits, 'purchases', purchases)
          ORDER BY pack_no) FROM packs), '[]'::jsonb),
      'purchases_per_member', COALESCE((SELECT jsonb_object_agg(b, n) FROM (
          SELECT CASE WHEN purchases = 1 THEN '1' WHEN purchases = 2 THEN '2'
                      WHEN purchases BETWEEN 3 AND 5 THEN '3-5' ELSE '6+' END AS b, count(*) n
          FROM per_member GROUP BY 1) a), '{}'::jsonb))
    ELSE '"unavailable: credit_grants does not exist"'::jsonb END,
  'idempotency', CASE WHEN (SELECT has_grants FROM have) THEN jsonb_build_object(
      'duplicate_event_ids',   (SELECT count(*) FROM (SELECT stripe_event_id FROM grants
                                  GROUP BY 1 HAVING count(*) > 1) d),
      'duplicate_session_ids', (SELECT count(*) FROM (SELECT stripe_session_id FROM grants
                                  GROUP BY 1 HAVING count(*) > 1) d),
      'note', 'Both are UNIQUE columns, so a nonzero value would mean the constraint is missing. '
           || 'Zero is the expected and enforced result, not merely the observed one.')
    ELSE '"unavailable"'::jsonb END,
  'credited_without_payment', CASE WHEN (SELECT has_grants FROM have) THEN jsonb_build_object(
      'grants_with_nonpositive_amount', (SELECT count(*) FROM grants WHERE amount_total <= 0),
      'grants_with_nonpositive_credits',(SELECT count(*) FROM grants WHERE credits <= 0),
      'note', 'CHECK constraints already forbid both. A nonzero count means a constraint was dropped.')
    ELSE '"unavailable"'::jsonb END,
  'paid_but_not_credited', jsonb_build_object(
    'determinable', false,
    'requires', 'Stripe',
    'why', 'This database records only SUCCESSFUL fulfilments (public.credit_grants). A payment '
        || 'captured but never granted leaves NO row here. ABSENCE OF A ROW IS NOT EVIDENCE OF A '
        || 'MISSING GRANT, and this audit will not infer one: a member who never bought anything '
        || 'and a member who paid and was never credited are indistinguishable from this side. '
        || 'The only sound method is external reconciliation — list completed Stripe Checkout '
        || 'Sessions for the credit-pack Prices and left-join them against '
        || 'credit_grants.stripe_session_id. Any number this audit produced would be fabricated.',
    'do_not_do', 'Do not treat total_grants < expected purchases as a paid-but-uncredited count.'),
  'pending_or_abandoned_sessions', jsonb_build_object(
    'determinable', false,
    'why', 'No reservation, claim, or pending-session table exists in this schema. Nothing to count.'),
  'reconciliation', CASE WHEN (SELECT has_grants FROM have) AND (SELECT has_mc FROM have) THEN
    jsonb_build_object(
      'members_with_grants',                    (SELECT count(*) FROM per_member),
      'members_whose_premium_is_below_credits_bought',
        (SELECT count(*) FROM per_member pm JOIN mc ON mc.user_id = pm.user_id
          WHERE mc.premium_credits < pm.credits_bought),
      'members_whose_premium_exceeds_credits_bought',
        (SELECT count(*) FROM per_member pm JOIN mc ON mc.user_id = pm.user_id
          WHERE mc.premium_credits > pm.credits_bought),
      'note', 'premium BELOW credits_bought is EXPECTED once purchased credits become spendable — '
           || 'today the match path charges free_credits only, so a gap suggests another writer '
           || 'reduced premium. premium ABOVE credits_bought means premium was granted by a path '
           || 'other than a Stripe purchase, which contradicts "premium = purchased only".')
    ELSE '"unavailable"'::jsonb END,
  'purchase_headroom_under_combined_cap_50', CASE WHEN (SELECT has_mc FROM have) THEN
    jsonb_build_object(
      'members_measured', (SELECT count(*) FROM headroom),
      'distribution', COALESCE((SELECT jsonb_object_agg(b, n) FROM (
        SELECT CASE WHEN headroom_50 = 0 THEN '0 (at or over cap)'
                    WHEN headroom_50 BETWEEN 1 AND 10  THEN '1-10'
                    WHEN headroom_50 BETWEEN 11 AND 25 THEN '11-25'
                    WHEN headroom_50 BETWEEN 26 AND 40 THEN '26-40'
                    ELSE '41-50' END AS b, count(*) n FROM headroom GROUP BY 1) a), '{}'::jsonb),
      'members_with_zero_headroom', (SELECT count(*) FROM headroom WHERE headroom_50 = 0),
      'median_headroom', (SELECT COALESCE(percentile_disc(0.5) WITHIN GROUP (ORDER BY headroom_50),0) FROM headroom))
    ELSE '"unavailable"'::jsonb END,
  'reading_notes', jsonb_build_array(
    'No Stripe event id, session id, price id, customer id, payment id, email, name or user id '
      || 'appears anywhere in this result. Price IDs are reduced to ordinals inside the query.',
    'members_with_zero_headroom sizes the population a "You can hold up to 50 credits" block would '
      || 'reject at checkout on day one.',
    'Anything this schema cannot prove is labelled determinable:false with the reason, rather than '
      || 'reported as zero. In particular paid-but-uncredited requires Stripe evidence and is NEVER '
      || 'inferred from the absence of a credit_grants row.')
)) AS credit_purchase_path_audit;
