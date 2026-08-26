-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- RECRUITER ROLE CENSUS — read-only. ONE statement. Safe for the Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Measures the populations needed to implement the agreed recruiter direction:
--
--   • two new role_type values: 'Executive Recruiter' and 'In-House Talent Leader'
--   • 'Executive Recruiter'    COUNTS as a business-solution provider (throttled)
--   • 'In-House Talent Leader' does NOT count as a provider
--   • 'Head of Talent' and every existing stored value are left exactly as they are
--   • no backfill, no reclassification of any member
--
-- ─── IDENTITY PROTECTION ──────────────────────────────────────────────────────────────────────
-- No id, name, email, company, bio or job-title text is emitted anywhere.
--
-- The recruiter probes read free-text titles but report only COUNTS — a job title can identify a
-- person on its own ("Global Head of Legal Search, <firm>").
--
-- profiles.role_type is FREE TEXT with no CHECK constraint, so an unrecognised value could in
-- principle be anything a member once typed. Unknown values are therefore emitted only at k >= 2
-- (held by two or more members, so the value cannot single anyone out); values held by exactly one
-- member are reported as a COUNT of distinct singletons and nothing else.
--
-- ─── WHAT "PROBABLE RECRUITER" MEANS ──────────────────────────────────────────────────────────
-- A keyword match on the member's own free-text title. It is an INDICATOR for sizing the work, not
-- a classification of anybody, and nothing is written or reclassified on the strength of it.
WITH real_members AS (
  -- The population every other audit uses: real people, excluding test and admin accounts.
  SELECT p.role_type, p.title, p.exact_job_title, p.profile_complete, p.account_status
  FROM public.profiles p
  WHERE p.is_test_account IS NOT TRUE
    AND p.is_admin IS NOT TRUE
),
pat(recruiter_any, external_sig, in_house_sig) AS (
  VALUES (
    -- ANY recruiter signal
    '(recruit|talent acquisition|executive search|search consultant|headhunt|staffing|talent partner)',
    -- EXTERNAL / agency / search-firm signal
    '(executive search|search consultant|search partner|headhunt|staffing|search firm|talent solutions|recruiting firm|agency recruit)',
    -- IN-HOUSE / employer-side signal
    '(talent acquisition|head of talent|talent partner|people team|internal recruit|in-house recruit|recruiting manager|director of recruiting|vp of talent|head of recruiting)'
  )
),
tagged AS (
  SELECT
    m.*,
    COALESCE(m.exact_job_title, m.title) ~* (SELECT recruiter_any FROM pat) AS is_probable_recruiter,
    COALESCE(m.exact_job_title, m.title) ~* (SELECT external_sig  FROM pat) AS has_external_signal,
    COALESCE(m.exact_job_title, m.title) ~* (SELECT in_house_sig  FROM pat) AS has_in_house_signal,
    -- The three classifiers that actually change matching behaviour today (lib/matching).
    lower(COALESCE(m.role_type,'')) LIKE '%law firm%'                                        AS cls_law_firm,
    lower(COALESCE(m.role_type,'')) ~ '(law firm|attorney|counsel|lawyer)'                   AS cls_legal_professional,
    lower(COALESCE(m.role_type,'')) ~ '(law firm|consultant|legal services|legal tech)'      AS cls_provider
  FROM real_members m
),
known_titles(v) AS (
  -- The 47 structured ROLE_CATEGORIES titles + the 'Other' sentinel, as of this audit.
  VALUES
    ('General Counsel'),('Chief Legal Officer'),('In-House Counsel'),('Deputy General Counsel'),
    ('Associate General Counsel'),('Law Firm Partner'),('Legal Operations'),
    ('CEO'),('Founder'),('President'),('COO'),('Chief Strategy Officer'),
    ('CFO'),('VP Finance'),('Controller'),('Treasurer'),('Head of FP&A'),
    ('CHRO'),('Chief People Officer'),('Head of Talent'),('HR Executive'),
    ('CRO'),('VP Sales'),('Head of Business Development'),('Partnerships Executive'),
    ('CMO'),('VP Marketing'),('Brand Executive'),
    ('Operations Executive'),('Transformation Executive'),
    ('CTO'),('CIO'),('CISO'),('Technology Executive'),('Cybersecurity Executive'),
    ('Government Affairs Executive'),('Public Policy Executive'),('Regulatory Affairs Executive'),
    ('Investor'),('General Partner'),('Managing Director'),('Operating Partner'),
    ('Portfolio Operations Executive'),
    ('Healthcare Executive'),('Life Sciences Executive'),
    ('Consultant'),('Advisor'),('Professional Services Executive'),
    ('Other')
),
legacy_titles(v) AS (
  -- Values the application maps to a category but which are not structured titles.
  VALUES
    ('In-house Counsel'),('Law Firm Attorney'),('Law firm attorney'),('Legal services professional'),
    ('Compliance'),('Risk'),('Privacy'),('Legal Tech Founder'),('Legal'),
    ('Regulatory Affairs'),('Government Affairs'),('Government / Policy'),('Government / Public Sector'),
    ('Executive / C-Suite'),('Investor / VC'),('Finance Professional'),('Finance'),
    ('Healthcare Professional'),('Healthcare')
),
role_counts AS (
  SELECT
    COALESCE(NULLIF(btrim(role_type), ''), '(null or blank)')  AS value,
    count(*)                                                    AS members,
    count(*) FILTER (WHERE profile_complete IS TRUE
                       AND account_status = 'active')           AS complete_and_active,
    count(*) FILTER (WHERE is_probable_recruiter)               AS probable_recruiters,
    (btrim(role_type) IN (SELECT v FROM known_titles))          AS is_structured,
    (btrim(role_type) IN (SELECT v FROM legacy_titles))         AS is_known_legacy
  FROM tagged
  GROUP BY 1, 5, 6
),
unknown_all AS (
  SELECT value, members FROM role_counts
  WHERE NOT is_structured AND NOT is_known_legacy AND value <> '(null or blank)'
),
-- ── EXTERNAL vs IN-HOUSE, inferred in aggregate only ────────────────────────────────────────
-- Decisions 2 and 3 treat these two populations differently, so their sizes matter before any
-- code is written. The split is a keyword inference on the member's own title and is deliberately
-- reported with an 'ambiguous' bucket rather than forced: nobody is classified by this query.
split AS (
  SELECT
    count(*)                                                                        AS probable_recruiters,
    count(*) FILTER (WHERE has_external_signal AND NOT has_in_house_signal)         AS external_signal_only,
    count(*) FILTER (WHERE has_in_house_signal AND NOT has_external_signal)         AS in_house_signal_only,
    count(*) FILTER (WHERE has_external_signal AND has_in_house_signal)             AS both_signals,
    count(*) FILTER (WHERE NOT has_external_signal AND NOT has_in_house_signal)     AS neither_signal
  FROM tagged WHERE is_probable_recruiter
),
-- ── COLLISION with the three live classifiers, among probable recruiters ────────────────────
collisions AS (
  SELECT
    count(*) FILTER (WHERE cls_law_firm)            AS classified_law_firm_today,
    count(*) FILTER (WHERE cls_legal_professional)  AS classified_legal_professional_today,
    count(*) FILTER (WHERE cls_provider)            AS classified_provider_today
  FROM tagged WHERE is_probable_recruiter
),
-- ── THE PROVIDER DELTA — what decisions 2 and 3 would actually change ────────────────────────
-- If a probable EXTERNAL recruiter moves to 'Executive Recruiter' (a provider), and they are
-- already classified as a provider today (usually via 'Consultant'), nothing changes for them.
-- If they are NOT a provider today, they would BECOME throttled — a real behaviour change for a
-- real person, and the number worth knowing before shipping.
-- Symmetrically, a probable IN-HOUSE recruiter who IS a provider today would STOP being throttled.
provider_delta AS (
  SELECT
    count(*) FILTER (WHERE has_external_signal AND NOT has_in_house_signal AND NOT cls_provider)
      AS external_would_newly_become_provider,
    count(*) FILTER (WHERE has_external_signal AND NOT has_in_house_signal AND cls_provider)
      AS external_already_provider_no_change,
    count(*) FILTER (WHERE has_in_house_signal AND NOT has_external_signal AND cls_provider)
      AS in_house_would_stop_being_provider,
    count(*) FILTER (WHERE has_in_house_signal AND NOT has_external_signal AND NOT cls_provider)
      AS in_house_already_not_provider_no_change
  FROM tagged WHERE is_probable_recruiter
),
-- ── Where probable recruiters sit today, by stored role. Counts only. ────────────────────────
filed_as AS (
  SELECT
    COALESCE(NULLIF(btrim(role_type), ''), '(null or blank)') AS role_type,
    count(*)                                                   AS members,
    count(*) FILTER (WHERE has_external_signal AND NOT has_in_house_signal) AS external_signal,
    count(*) FILTER (WHERE has_in_house_signal AND NOT has_external_signal) AS in_house_signal
  FROM tagged WHERE is_probable_recruiter
  GROUP BY 1
),
free_text AS (
  SELECT
    count(*) FILTER (WHERE title           ~* (SELECT recruiter_any FROM pat)) AS legacy_title_hits,
    count(*) FILTER (WHERE exact_job_title ~* (SELECT recruiter_any FROM pat)) AS exact_title_hits,
    count(*) FILTER (WHERE is_probable_recruiter)                              AS any_title_hits,
    count(*) FILTER (WHERE role_type       ~* (SELECT recruiter_any FROM pat)) AS role_type_hits
  FROM tagged
)
SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now(),
  'population', jsonb_build_object(
    'real_members', (SELECT count(*) FROM real_members),
    'note', 'excludes test and admin accounts; no identity is emitted anywhere in this result'),

  -- 1. The whole role_type vocabulary, with how many probable recruiters sit in each value.
  --    A STRUCTURED or KNOWN-LEGACY value comes from a fixed application list and identifies
  --    nobody, so it is always shown. An UNKNOWN value is free text a member once typed, so it is
  --    shown only at k >= 2; a singleton is reported with its count and its value redacted.
  'stored_role_values', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'value', CASE WHEN is_structured OR is_known_legacy OR value = '(null or blank)' THEN value
                    WHEN members >= 2 THEN value
                    ELSE '(unknown value, single member — redacted)' END,
      'members', members, 'complete_and_active', complete_and_active,
      'probable_recruiters', probable_recruiters,
      'classification', CASE WHEN value = '(null or blank)' THEN 'unset'
                             WHEN is_structured THEN 'structured'
                             WHEN is_known_legacy THEN 'known_legacy'
                             ELSE 'UNKNOWN — not in the application taxonomy' END)
      ORDER BY members DESC, 1) FROM role_counts), '[]'::jsonb),

  -- 2. Recruiter signal in free text. COUNTS ONLY — no title string is ever emitted.
  'recruiter_signal_in_free_text', (SELECT to_jsonb(free_text) FROM free_text),

  -- 3. Probable EXTERNAL vs IN-HOUSE, the split decisions 2 and 3 turn on.
  'external_vs_in_house_inference', (SELECT to_jsonb(split) FROM split),

  -- 4. Where those people are filed today.
  'probable_recruiters_filed_as', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'role_type', role_type, 'members', members,
      'external_signal', external_signal, 'in_house_signal', in_house_signal)
      ORDER BY members DESC, role_type) FROM filed_as), '[]'::jsonb),

  -- 5. Do they already collide with a live classifier?
  'classifier_collisions_today', (SELECT to_jsonb(collisions) FROM collisions),

  -- 6. What decisions 2 and 3 would change for real members.
  'provider_throttle_delta', (SELECT to_jsonb(provider_delta) FROM provider_delta),

  -- 7. Unknown values, k-anonymised.
  'unknown_stored_values_k2', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('value', value, 'members', members)
      ORDER BY members DESC, value) FROM unknown_all WHERE members >= 2), '[]'::jsonb),
  'unknown_singleton_values', jsonb_build_object(
    'distinct_values', (SELECT count(*) FROM unknown_all WHERE members = 1),
    'note', 'held by exactly one member each, so the value itself is withheld — a free-text '
         || 'role_type could identify a person'),

  'reading_notes', jsonb_build_array(
    'role_type is plain text with NO database CHECK, so adding the two new values needs no migration.',
    'probable_recruiter is a keyword INDICATOR on the member''s own title, for sizing only. Nobody '
      || 'is classified, reclassified or written to by this query.',
    'external_vs_in_house_inference keeps an ambiguous bucket on purpose. both_signals and '
      || 'neither_signal are the members whose side cannot be inferred from a title alone — they '
      || 'will self-select during onboarding, which is the only reliable source.',
    'provider_throttle_delta is the operational number: external_would_newly_become_provider is how '
      || 'many existing members would start being throttled as vendors once decision 2 ships, and '
      || 'in_house_would_stop_being_provider is how many would stop.',
    'classifier_collisions_today shows misclassification that is ALREADY happening — a recruiter '
      || 'stored as Consultant is treated as a business-solution provider right now.',
    'Free-text role_type values are k-anonymised: a value held by exactly one member is redacted '
      || 'everywhere it would otherwise appear, because such a value could identify that member. '
      || 'Structured and known-legacy values come from a fixed application list and are always shown.',
    'No name, email, UUID, company, bio or job title appears in this result.')
)) AS recruiter_census;
