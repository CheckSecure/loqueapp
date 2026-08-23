-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- INCOMPLETE-ONBOARDING / INVITATION-RESUME AUDIT  (corrected)
--
-- STRICTLY READ-ONLY. Every statement is a SELECT. No DML, DDL, locks, temp objects, dynamic SQL,
-- side-effecting functions or SELECT INTO. Running it changes nothing and sends nothing.
--
-- ─── HOW TO RUN IT ────────────────────────────────────────────────────────────────────────────
-- Supabase's SQL editor renders only the FINAL statement's result set. This file therefore has
-- exactly TWO statements:
--
--   STATEMENT 1 — duplicate identities. Per-row, masked. DIFFERENT schema, so it cannot be merged
--                 into statement 2. To see it, SELECT JUST THIS STATEMENT and run it alone.
--   STATEMENT 2 — everything else (the former sections 1-8) in ONE result set with a uniform
--                 (section, metric, value, detail) schema. This is the last statement, so it is
--                 what the editor shows by default.
--
-- The previous version had nine independent statements; eight of their results were invisible in
-- the editor. That is corrected here.
--
-- ─── WHAT CHANGED, AND WHY ────────────────────────────────────────────────────────────────────
-- DEFECT 1 (duplicate identities were not proven). The old duplicate query built the masked address
-- inside each branch and then did GROUP BY 2 — column 2 was the MASK. Two different addresses that
-- share a first character, a last character and a domain (arato@ and alberto@; daniel@ and dl@)
-- collapse into one mask and were reported as a duplicate. Grouping now happens on
-- lower(pg_catalog.btrim(email)) — the exact normalized address — and masking is applied only in an
-- OUTER select, after HAVING count(*) > 1. The normalized address is never emitted.
--
-- DEFECT 2 (join multiplication). The old sections joined waitlist -> auth.users on the email and
-- then counted rows. An address carrying two auth users multiplied its waitlist row into two, so
-- every funnel count silently inflated — and the inflation was invisible because the ambiguous
-- cohort is exactly the cohort those counts most needed to isolate. Statement 2 now aggregates
-- auth.users and waitlist to ONE ROW PER NORMALIZED ADDRESS *before* joining, so multiplication is
-- impossible by construction rather than by care.
--
-- ─── THE UNIT OF COUNTING, STATED ONCE ────────────────────────────────────────────────────────
-- Unless a metric's `detail` says otherwise, every value in statement 2 counts UNIQUE NORMALIZED
-- EMAIL ADDRESSES APPEARING ON THE WAITLIST — not waitlist rows, not auth users, not profiles.
-- Metrics that count something else say so explicitly in `detail`.
--
-- ─── PRIVACY ──────────────────────────────────────────────────────────────────────────────────
-- No full address, name, token, provider payload, message content or raw error is selected
-- anywhere. Statement 1 emits a masked address only; statement 2 emits no address at all.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════


-- ═══ STATEMENT 1 — DUPLICATE IDENTITIES (run this one on its own) ═══════════════════════════════
-- Grouping is on the EXACT normalized address. Masking happens in the outer select, after the
-- HAVING, so it can never influence which rows are considered duplicates. Every row here is a real
-- duplicate of one normalized address; the mask is only how it is displayed.
SELECT
  'duplicate identities (masked)' AS section,
  d.source,
  left(split_part(d.norm_email, '@', 1), 1) || '***' ||
    right(split_part(d.norm_email, '@', 1), 1) || '@' ||
    split_part(d.norm_email, '@', 2)          AS masked_address,
  d.occurrences
FROM (
  SELECT 'waitlist'   AS source, lower(pg_catalog.btrim(w.email)) AS norm_email, count(*) AS occurrences
    FROM public.waitlist w  WHERE w.email IS NOT NULL
   GROUP BY lower(pg_catalog.btrim(w.email)) HAVING count(*) > 1
  UNION ALL
  SELECT 'auth.users',        lower(pg_catalog.btrim(u.email)), count(*)
    FROM auth.users u        WHERE u.email IS NOT NULL
   GROUP BY lower(pg_catalog.btrim(u.email)) HAVING count(*) > 1
  UNION ALL
  SELECT 'profiles',          lower(pg_catalog.btrim(p.email)), count(*)
    FROM public.profiles p   WHERE p.email IS NOT NULL
   GROUP BY lower(pg_catalog.btrim(p.email)) HAVING count(*) > 1
) d
ORDER BY d.occurrences DESC, d.source, masked_address;


-- ═══ STATEMENT 2 — EVERYTHING ELSE, ONE RESULT SET ═════════════════════════════════════════════
WITH
-- One row per NORMALIZED ADDRESS on the waitlist. Aggregated BEFORE any join, so a duplicate
-- waitlist row cannot multiply anything downstream.
wl AS (
  SELECT lower(pg_catalog.btrim(w.email))                                        AS norm_email,
         count(*)                                                                AS waitlist_rows,
         max(w.invited_at)                                                       AS invited_at,
         bool_or(w.status = 'invited')                                           AS is_invited,
         bool_or(w.status = 'revoked')                                           AS is_revoked,
         bool_or(w.status = 'declined')                                          AS is_declined,
         bool_or(w.invite_reminder_1_sent_at IS NOT NULL)                        AS r1_sent,
         bool_or(w.invite_reminder_2_sent_at IS NOT NULL)                        AS r2_sent
  FROM public.waitlist w
  WHERE w.email IS NOT NULL
  GROUP BY 1
),
-- One row per NORMALIZED ADDRESS in auth.users. auth_count > 1 is the ambiguous cohort:
-- sendSecureInvite already hard-stops on it, so it must be excluded from eligibility, not counted
-- into it. single_auth_id is meaningful ONLY when auth_count = 1 and is NULL otherwise.
au AS (
  SELECT lower(pg_catalog.btrim(u.email))                                        AS norm_email,
         count(*)                                                                AS auth_count,
         CASE WHEN count(*) = 1 THEN (array_agg(u.id))[1] END                    AS single_auth_id,
         max(u.last_sign_in_at)                                                  AS last_sign_in_at
  FROM auth.users u
  WHERE u.email IS NOT NULL
  GROUP BY 1
),
-- EXACTLY ONE ROW PER NORMALIZED WAITLIST ADDRESS. Both sides are pre-aggregated and the profile
-- is attached only through an unambiguous single auth id, so no join can multiply a row.
person AS (
  SELECT wl.norm_email, wl.waitlist_rows, wl.invited_at, wl.is_invited, wl.is_revoked,
         wl.is_declined, wl.r1_sent, wl.r2_sent,
         COALESCE(au.auth_count, 0)      AS auth_count,
         au.single_auth_id,
         au.last_sign_in_at,
         p.id                            AS profile_id,
         p.profile_complete,
         p.onboarding_step,
         p.updated_at                    AS profile_updated_at,
         p.is_admin
  FROM wl
  LEFT JOIN au ON au.norm_email = wl.norm_email
  LEFT JOIN public.profiles p ON p.id = au.single_auth_id
),
-- Provider suppression, per normalized address. EXISTS, so it cannot multiply either.
supp AS (
  SELECT lower(pg_catalog.btrim(d.recipient_email)) AS norm_email
  FROM public.invitation_deliveries d
  WHERE d.status IN ('bounced', 'blocked', 'complained')
  GROUP BY 1
),
-- THE ELIGIBILITY PREDICATE, defined once. Completion-based, never sign-in-based. Ambiguous
-- addresses are excluded here AND counted as unsafe below — they are not silently dropped.
eligible AS (
  SELECT pr.*
  FROM person pr
  WHERE pr.is_invited
    AND NOT pr.is_revoked
    AND NOT pr.is_declined
    AND pr.invited_at IS NOT NULL
    AND pr.auth_count = 1
    AND (pr.profile_id IS NULL OR pr.profile_complete IS DISTINCT FROM true)
    AND (pr.is_admin IS DISTINCT FROM true)
    AND NOT EXISTS (SELECT 1 FROM supp s WHERE s.norm_email = pr.norm_email)
    AND (pr.profile_updated_at IS NULL OR pr.profile_updated_at < now() - interval '24 hours')
)
SELECT section, metric, value::text AS value, detail
FROM (
  -- ── 1. FUNNEL ───────────────────────────────────────────────────────────────────────────────
  SELECT '1. funnel' AS section, 'waitlist addresses (unique, normalized)' AS metric,
         (SELECT count(*) FROM person) AS value,
         'the denominator for every other unit-of-address metric' AS detail
  UNION ALL SELECT '1. funnel', 'waitlist ROWS (inflated by duplicates)',
         (SELECT count(*) FROM public.waitlist WHERE email IS NOT NULL),
         'counts ROWS, not addresses; a gap vs. the line above means duplicate waitlist rows exist'
  UNION ALL SELECT '1. funnel', 'invited, NO auth user (orphan invite)',
         (SELECT count(*) FROM person WHERE is_invited AND auth_count = 0),
         'unique addresses; invite send never created a user'
  UNION ALL SELECT '1. funnel', 'auth user exists, NO profile row',
         (SELECT count(*) FROM person WHERE auth_count = 1 AND profile_id IS NULL),
         'unique addresses with exactly one auth user'
  UNION ALL SELECT '1. funnel', 'profile exists but INCOMPLETE',
         (SELECT count(*) FROM person WHERE profile_id IS NOT NULL AND profile_complete IS DISTINCT FROM true),
         'unique addresses'
  UNION ALL SELECT '1. funnel', 'profile COMPLETE',
         (SELECT count(*) FROM person WHERE profile_complete = true),
         'unique addresses'
  UNION ALL SELECT '1. funnel', 'profile COMPLETE but waitlist still says invited',
         (SELECT count(*) FROM person WHERE profile_complete = true AND is_invited),
         'unique addresses; stale waitlist status, harmless but should not be reminded'
  UNION ALL SELECT '1. funnel', 'invitation REVOKED',
         (SELECT count(*) FROM person WHERE is_revoked), 'unique addresses'
  UNION ALL SELECT '1. funnel', 'signed in but profile INCOMPLETE  <-- the stuck cohort',
         (SELECT count(*) FROM person WHERE last_sign_in_at IS NOT NULL
            AND (profile_id IS NULL OR profile_complete IS DISTINCT FROM true)),
         'unique addresses; the cohort the current cron permanently disqualifies'

  -- ── 2. DEAD-ENDS in the CURRENT cron ────────────────────────────────────────────────────────
  UNION ALL SELECT '2. current-cron dead-ends', 'aged past the 23-48h window, reminder 1 never sent',
         (SELECT count(*) FROM person WHERE is_invited AND invited_at < now() - interval '48 hours'
            AND NOT r1_sent AND (profile_id IS NULL OR profile_complete IS DISTINCT FROM true)),
         'unique addresses; permanently ineligible for BOTH reminders under the current logic'
  UNION ALL SELECT '2. current-cron dead-ends', 'disqualified by last_sign_in_at despite incomplete profile',
         (SELECT count(*) FROM person WHERE last_sign_in_at IS NOT NULL
            AND (profile_id IS NULL OR profile_complete IS DISTINCT FROM true)),
         'unique addresses'
  UNION ALL SELECT '2. current-cron dead-ends', 'both reminders sent, still incomplete',
         (SELECT count(*) FROM person WHERE r1_sent AND r2_sent
            AND (profile_id IS NULL OR profile_complete IS DISTINCT FROM true)),
         'unique addresses'

  -- ── 3. ELIGIBILITY under the PROPOSED completion-based predicate ────────────────────────────
  UNION ALL SELECT '3. proposed eligibility', 'total eligible',
         (SELECT count(*) FROM eligible),
         'unique addresses; invited + unambiguous + incomplete + not suppressed + not admin + idle >24h'
  UNION ALL SELECT '3. proposed eligibility', 'stage 1 due (>= 24h, < 3d)',
         (SELECT count(*) FROM eligible WHERE invited_at <= now() - interval '24 hours'
            AND invited_at > now() - interval '3 days'), 'unique addresses'
  UNION ALL SELECT '3. proposed eligibility', 'stage 2 due (>= 3d, < 7d)',
         (SELECT count(*) FROM eligible WHERE invited_at <= now() - interval '3 days'
            AND invited_at > now() - interval '7 days'), 'unique addresses'
  UNION ALL SELECT '3. proposed eligibility', 'stage 3 due (>= 7d, < 30d)',
         (SELECT count(*) FROM eligible WHERE invited_at <= now() - interval '7 days'
            AND invited_at > now() - interval '30 days'), 'unique addresses'
  UNION ALL SELECT '3. proposed eligibility', 'BACKLOG older than 30d  <-- day-one send risk',
         (SELECT count(*) FROM eligible WHERE invited_at <= now() - interval '30 days'),
         'unique addresses; floor-based cutoffs make these all immediately stage-3 due'

  -- ── 4. AGE since invitation ─────────────────────────────────────────────────────────────────
  UNION ALL SELECT '4. age since invitation', 'a. < 24h',
         (SELECT count(*) FROM person WHERE is_invited AND invited_at > now() - interval '24 hours'), 'unique addresses'
  UNION ALL SELECT '4. age since invitation', 'b. 24h - 3d',
         (SELECT count(*) FROM person WHERE is_invited AND invited_at <= now() - interval '24 hours'
            AND invited_at > now() - interval '3 days'), 'unique addresses'
  UNION ALL SELECT '4. age since invitation', 'c. 3d - 7d',
         (SELECT count(*) FROM person WHERE is_invited AND invited_at <= now() - interval '3 days'
            AND invited_at > now() - interval '7 days'), 'unique addresses'
  UNION ALL SELECT '4. age since invitation', 'd. 7d - 30d',
         (SELECT count(*) FROM person WHERE is_invited AND invited_at <= now() - interval '7 days'
            AND invited_at > now() - interval '30 days'), 'unique addresses'
  UNION ALL SELECT '4. age since invitation', 'e. > 30d',
         (SELECT count(*) FROM person WHERE is_invited AND invited_at <= now() - interval '30 days'), 'unique addresses'
  UNION ALL SELECT '4. age since invitation', 'f. invited status, no invited_at',
         (SELECT count(*) FROM person WHERE is_invited AND invited_at IS NULL),
         'unique addresses; cannot be staged at all until repaired'

  -- ── 5. AGE since last profile activity ──────────────────────────────────────────────────────
  UNION ALL SELECT '5. age since profile activity', 'no profile row yet',
         (SELECT count(*) FROM person WHERE is_invited AND profile_id IS NULL), 'unique addresses'
  UNION ALL SELECT '5. age since profile activity', 'a. < 24h (ACTIVE - do not nudge)',
         (SELECT count(*) FROM person WHERE profile_id IS NOT NULL
            AND profile_complete IS DISTINCT FROM true
            AND profile_updated_at > now() - interval '24 hours'), 'unique addresses'
  UNION ALL SELECT '5. age since profile activity', 'b. 1 - 7d',
         (SELECT count(*) FROM person WHERE profile_id IS NOT NULL
            AND profile_complete IS DISTINCT FROM true
            AND profile_updated_at <= now() - interval '24 hours'
            AND profile_updated_at > now() - interval '7 days'), 'unique addresses'
  UNION ALL SELECT '5. age since profile activity', 'c. > 7d',
         (SELECT count(*) FROM person WHERE profile_id IS NOT NULL
            AND profile_complete IS DISTINCT FROM true
            AND profile_updated_at <= now() - interval '7 days'), 'unique addresses'
  UNION ALL SELECT '5. age since profile activity', 'past step zero',
         (SELECT count(*) FROM person WHERE profile_complete IS DISTINCT FROM true
            AND onboarding_step IS NOT NULL AND onboarding_step > 0),
         'unique addresses; started the wizard and stopped'

  -- ── 6. DELIVERY EVIDENCE ────────────────────────────────────────────────────────────────────
  UNION ALL SELECT '6. delivery evidence', 'invitation_deliveries rows total',
         (SELECT count(*) FROM public.invitation_deliveries), 'counts DELIVERY ATTEMPTS, not addresses'
  UNION ALL SELECT '6. delivery evidence', 'distinct recipients with any attempt',
         (SELECT count(DISTINCT lower(pg_catalog.btrim(recipient_email))) FROM public.invitation_deliveries),
         'unique normalized addresses'
  UNION ALL SELECT '6. delivery evidence', 'attempts: delivered',
         (SELECT count(*) FROM public.invitation_deliveries WHERE status = 'delivered'), 'attempts'
  UNION ALL SELECT '6. delivery evidence', 'attempts: accepted (provider took it, delivery unconfirmed)',
         (SELECT count(*) FROM public.invitation_deliveries WHERE status = 'accepted'), 'attempts'
  UNION ALL SELECT '6. delivery evidence', 'attempts: still claimed (in flight)',
         (SELECT count(*) FROM public.invitation_deliveries WHERE status = 'claimed'), 'attempts'
  UNION ALL SELECT '6. delivery evidence', 'attempts: bounced/blocked/complained',
         (SELECT count(*) FROM public.invitation_deliveries
           WHERE status IN ('bounced','blocked','complained')), 'attempts'
  UNION ALL SELECT '6. delivery evidence', 'attempts: failed',
         (SELECT count(*) FROM public.invitation_deliveries WHERE status = 'failed'), 'attempts'

  -- ── 7. DELIVERY-RECORD COVERAGE ─────────────────────────────────────────────────────────────
  UNION ALL SELECT '7. delivery coverage', 'invited with NO delivery record at all',
         (SELECT count(*) FROM person pr WHERE pr.is_invited
            AND NOT EXISTS (SELECT 1 FROM public.invitation_deliveries d
                             WHERE lower(pg_catalog.btrim(d.recipient_email)) = pr.norm_email)),
         'unique addresses; predates durable tracking - "we emailed you before" cannot be asserted'

  -- ── 8. UNSAFE-TO-SEND STATES ────────────────────────────────────────────────────────────────
  UNION ALL SELECT '8. unsafe to send', 'AMBIGUOUS: more than one auth user at the address',
         (SELECT count(*) FROM au WHERE auth_count > 1),
         'unique addresses; hard stop - excluded from eligibility, must be merged by an operator'
  UNION ALL SELECT '8. unsafe to send', 'ambiguous AND on the waitlist as invited',
         (SELECT count(*) FROM person WHERE auth_count > 1 AND is_invited),
         'unique addresses; the subset that would otherwise look reminder-eligible'
  UNION ALL SELECT '8. unsafe to send', 'suppressed at the provider (bounced/blocked/complained)',
         (SELECT count(*) FROM person pr WHERE EXISTS (SELECT 1 FROM supp s WHERE s.norm_email = pr.norm_email)),
         'unique addresses'
  UNION ALL SELECT '8. unsafe to send', 'revoked',
         (SELECT count(*) FROM person WHERE is_revoked), 'unique addresses'
  UNION ALL SELECT '8. unsafe to send', 'declined',
         (SELECT count(*) FROM person WHERE is_declined), 'unique addresses'
  UNION ALL SELECT '8. unsafe to send', 'admin account with an incomplete profile',
         (SELECT count(*) FROM person WHERE is_admin = true AND profile_complete IS DISTINCT FROM true),
         'unique addresses; excluded unless explicitly selected for testing'
  UNION ALL SELECT '8. unsafe to send', 'orphan profile (no auth user)',
         (SELECT count(*) FROM public.profiles p
           WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)),
         'counts PROFILE ROWS, not addresses'
  UNION ALL SELECT '8. unsafe to send', 'duplicate normalized addresses in auth.users',
         (SELECT count(*) FROM au WHERE auth_count > 1),
         'unique addresses; cross-check against statement 1 - if these disagree, statement 1 was misread'
  UNION ALL SELECT '8. unsafe to send', 'duplicate normalized addresses on the waitlist',
         (SELECT count(*) FROM wl WHERE waitlist_rows > 1), 'unique addresses'
) x
ORDER BY section, metric;
