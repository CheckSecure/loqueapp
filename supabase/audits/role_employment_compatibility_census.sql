-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- ROLE ↔ EMPLOYMENT COMPATIBILITY CENSUS — read-only. ONE statement. Aggregate only.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Counts existing members whose stored role and employment presentation contradict each other.
-- It CHANGES NOTHING and reclassifies nobody: the rule is enforced going forward at the write
-- paths, and any correction to an existing member is a deliberate, member-visible act.
--
-- NO IDENTITIES. Counts and fixed vocabulary values only — no id, name, email, company text, bio
-- or job title is emitted. Company is read solely to classify it against the placeholder lists;
-- the string itself never leaves the query.
--
-- ─── IT MIRRORS THE CODE, RULE FOR RULE ───────────────────────────────────────────────────────
-- The vocabulary below is a transcription of lib/professionalIdentity.ts (the placeholder sets and
-- their prefix rules) and lib/profile/roleEmploymentCompatibility.ts (the role families, the
-- status precedence, and the order the checks run in). A vitest case pins the two together so they
-- cannot drift. Every bucket is one rule; the role-family rules take precedence exactly as the
-- code evaluates them, so each member is counted at most once.
--
-- ─── HOW "INDEPENDENT" IS DETERMINED ──────────────────────────────────────────────────────────
-- There is no stored `independent` status. The selectable vocabulary is
-- employed | between_roles | consulting_advisory. A stored status is the AUTHORITY whenever it is
-- present; the company text is read only as a legacy fallback for rows that predate the field.
-- So 'employed' + a placeholder company stays EMPLOYED and is counted as "no genuine employer" —
-- that is the contradiction the member is shown, not a silent reinterpretation.
WITH real_members AS (
  SELECT p.role_type, p.current_status, p.company
  FROM public.profiles p
  WHERE p.is_test_account IS NOT TRUE AND p.is_admin IS NOT TRUE
),
vocab AS (
  SELECT
    -- IN_HOUSE_LEGAL_ROLES / LAW_FIRM_ROLES, from lib/profile/roleEmploymentCompatibility.ts
    ARRAY['General Counsel','Chief Legal Officer','In-House Counsel','In-house Counsel',
          'Deputy General Counsel','Associate General Counsel','Corporate Counsel'] AS in_house,
    ARRAY['Law Firm Partner','Law Firm Attorney','Law firm attorney']               AS law_firm,
    -- The placeholder sets, from lib/professionalIdentity.ts
    ARRAY[
      'independent','self employed','selfemployed','self','freelance','freelancer',
      'fractional','consultant','consulting','advisor','advisory','sole proprietor',
      'sole trader','owner operator','independent contractor','contractor']                                                                              AS ph_independent,
    ARRAY[
      'between roles','between jobs','in between roles','in transition','transitioning',
      'unemployed','open to work','job seeking','career break','sabbatical','on sabbatical']                                                                              AS ph_between,
    ARRAY[
      'retired','retiree']                                                                              AS ph_retired,
    ARRAY[
      'confidential','private','undisclosed','prefer not to say','n a','na','none',
      'unlisted']                                                                              AS ph_confidential,
    ARRAY[
      'stealth','stealth startup','stealth mode','stealth co','stealth company']                                                                              AS ph_stealth
),
tagged AS (
  SELECT
    m.*,
    btrim(COALESCE(m.role_type,''))                                             AS role,
    -- norm(): lowercase, punctuation to space, collapse whitespace — same as professionalIdentity
    btrim(regexp_replace(lower(regexp_replace(COALESCE(m.company,''), '[.,/#!$%^&*;:{}=\-_`~()]', ' ', 'g')), '\s+', ' ', 'g')) AS company_norm,
    (btrim(COALESCE(m.role_type,'')) = ANY (v.in_house))                        AS is_in_house_role,
    (btrim(COALESCE(m.role_type,'')) = ANY (v.law_firm))                        AS is_law_firm_role,
    v.ph_independent, v.ph_between, v.ph_retired, v.ph_confidential, v.ph_stealth
  FROM real_members m CROSS JOIN vocab v
),
classified AS (
  -- companySituation(): the SAME order of tests, including the prefix rules.
  SELECT
    t.*,
    CASE
      WHEN t.company_norm = '' THEN NULL
      WHEN t.company_norm = ANY (t.ph_independent)
        OR t.company_norm ~ '^(independent|freelance|self employed|selfemployed|fractional)\y' THEN 'independent'
      WHEN t.company_norm = ANY (t.ph_stealth)     OR t.company_norm ~ '^stealth\y'      THEN 'stealth'
      WHEN t.company_norm = ANY (t.ph_between)     OR t.company_norm ~ '^between (roles|jobs)\y' THEN 'between_roles'
      WHEN t.company_norm = ANY (t.ph_retired)                                            THEN 'retired'
      WHEN t.company_norm = ANY (t.ph_confidential)                                       THEN 'confidential'
      ELSE 'employed'
    END                                                                         AS company_situation
  FROM tagged t
),
situated AS (
  -- effectiveSituation(): a stored status wins outright; the company is the legacy fallback only.
  SELECT
    c.*,
    -- NULL-safe: company_situation is NULL for an empty company, and a NULL here would make
    -- every `NOT has_genuine_company` filter drop the row instead of counting it.
    (c.company_situation IS NOT DISTINCT FROM 'employed')                       AS has_genuine_company,
    CASE btrim(COALESCE(c.current_status,''))
      WHEN 'employed'            THEN 'employed'
      WHEN 'between_roles'       THEN 'between_roles'
      WHEN 'consulting_advisory' THEN 'independent'
      WHEN '' THEN CASE c.company_situation
                     WHEN 'independent'   THEN 'independent'
                     WHEN 'between_roles' THEN 'between_roles'
                     WHEN 'employed'      THEN 'employed'
                     ELSE 'unknown'            -- empty, retired, confidential, stealth
                   END
      ELSE 'unknown'                           -- an unrecognised stored value
    END                                                                         AS effective_situation
  FROM classified c
),
incompatible AS (
  -- One FILTER per rule, in the order checkRoleEmploymentCompatibility evaluates them, so no
  -- member is counted twice and the in-house / law-firm messages keep their precedence.
  SELECT
    count(*) FILTER (WHERE is_in_house_role AND effective_situation = 'independent')
                                                                                AS in_house_but_independent,
    count(*) FILTER (WHERE is_in_house_role AND effective_situation = 'between_roles')
                                                                                AS in_house_but_between_roles,
    count(*) FILTER (WHERE is_in_house_role
                       AND effective_situation NOT IN ('independent','between_roles')
                       AND NOT has_genuine_company)                             AS in_house_without_employer,
    count(*) FILTER (WHERE is_law_firm_role AND effective_situation = 'between_roles')
                                                                                AS law_firm_but_between_roles,
    count(*) FILTER (WHERE is_law_firm_role AND effective_situation <> 'between_roles'
                       AND NOT has_genuine_company)                             AS law_firm_without_firm_name,
    -- The generic rule, for every role with no family rule of its own: a STORED 'employed' status
    -- asserts an employer, so a placeholder or empty company contradicts it outright.
    -- `role = ''` returns OK immediately in the code (there is nothing to contradict), so a
    -- member with no role stored is not counted here either.
    count(*) FILTER (WHERE role <> '' AND NOT is_in_house_role AND NOT is_law_firm_role
                       AND btrim(COALESCE(current_status,'')) = 'employed'
                       AND NOT has_genuine_company)                             AS employed_without_employer,
    count(*) FILTER (WHERE is_in_house_role)                                    AS in_house_total,
    count(*) FILTER (WHERE is_law_firm_role)                                    AS law_firm_total
  FROM situated
),
status_mix AS (
  SELECT
    COALESCE(NULLIF(btrim(COALESCE(current_status,'')), ''), '(unset)')          AS status,
    count(*)                                                                     AS members,
    count(*) FILTER (WHERE is_in_house_role)                                     AS with_in_house_role
  FROM situated GROUP BY 1
)
SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now(),
  'population', jsonb_build_object(
    'real_members', (SELECT count(*) FROM real_members),
    'note', 'excludes test and admin accounts; no identity is emitted anywhere in this result'),
  'role_populations', jsonb_build_object(
    'in_house_legal_roles', (SELECT in_house_total FROM incompatible),
    'law_firm_roles', (SELECT law_firm_total FROM incompatible)),
  'incompatible_combinations', jsonb_build_object(
    'in_house_role_but_presents_independent', (SELECT in_house_but_independent FROM incompatible),
    'in_house_role_but_between_roles', (SELECT in_house_but_between_roles FROM incompatible),
    'in_house_role_without_a_named_employer', (SELECT in_house_without_employer FROM incompatible),
    'law_firm_role_but_between_roles', (SELECT law_firm_but_between_roles FROM incompatible),
    'law_firm_role_without_a_firm_name', (SELECT law_firm_without_firm_name FROM incompatible),
    'any_other_role_employed_without_a_genuine_employer',
      (SELECT employed_without_employer FROM incompatible)),
  'incompatible_total', (SELECT in_house_but_independent + in_house_but_between_roles
                              + in_house_without_employer + law_firm_but_between_roles
                              + law_firm_without_firm_name + employed_without_employer
                         FROM incompatible),
  'employment_status_mix', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('status', status, 'members', members,
                                        'holding_an_in_house_role', with_in_house_role)
      ORDER BY members DESC, status) FROM status_mix), '[]'::jsonb),
  'reading_notes', jsonb_build_array(
    'The six buckets are the six rules the write paths now enforce, one bucket per rule, each '
      || 'member counted at most once. A non-zero count is an EXISTING member whose profile '
      || 'already contradicts itself — not something this change caused.',
    'Nothing here reclassifies anyone. Correcting an existing member is a deliberate act, and the '
      || 'member should choose which of the two fields is wrong.',
    'A member with no employment status set and a real company is treated as employed, and is not '
      || 'counted as incompatible: this refuses contradictions, not silence.',
    'No name, email, UUID, company text, bio or job title appears in this result.')
)) AS compatibility_census;
