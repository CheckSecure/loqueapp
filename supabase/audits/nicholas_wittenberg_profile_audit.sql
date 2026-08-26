-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- NICHOLAS WITTENBERG — profile audit. READ-ONLY. One statement. Run before any repair.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Answers one question: is there EXACTLY ONE profile for this person, and what does it currently
-- hold? The repair artifact refuses to run unless this returns exactly one match, so this query is
-- the gate, not a formality.
--
-- ─── IT MIRRORS THE CODE, RULE FOR RULE ───────────────────────────────────────────────────────
-- An earlier version of this file kept its OWN short placeholder list, which lacked 'self' among
-- 25 other values. It therefore reported company_is_genuine: true for a company of "Self" — a
-- value the validator rejects. There is now one vocabulary: the arrays below are a transcription
-- of lib/professionalIdentity.ts, and the classification, precedence and verdict below transcribe
-- lib/profile/roleEmploymentCompatibility.ts. A vitest case pins them together so they cannot
-- drift again. The census SQL is generated from the same source.
--
-- ─── WHAT IT EMITS, AND NOTHING ELSE ──────────────────────────────────────────────────────────
--   match_count, and per match: id (needed to pin the repair), MASKED email, role_type,
--   exact_job_title, title, company, current_status, account_status, profile_complete,
--   the display line those fields currently produce, the compatibility verdict, and
--   pins_to_paste (the literals the repair requires). Nothing else about the person is read.
--
-- No bio, avatar, location, phone, LinkedIn, credits, matches, introductions, or any other field.
-- The id is emitted deliberately — the repair pins it, and a repair that guessed which row to
-- touch would be far more dangerous than showing a UUID to the operator who owns the database.
--
-- Email is MASKED (first character + domain) — enough to tell two people apart, not enough to be a
-- contact list. If two rows share a masked form the operator can widen the query themselves; this
-- file will not do it for them.
WITH vocab AS (
  SELECT
    -- IN_HOUSE_LEGAL_ROLES / LAW_FIRM_ROLES, from lib/profile/roleEmploymentCompatibility.ts
    ARRAY['General Counsel','Chief Legal Officer','In-House Counsel','In-house Counsel',
          'Deputy General Counsel','Associate General Counsel','Corporate Counsel'] AS in_house,
    ARRAY['Law Firm Partner','Law Firm Attorney','Law firm attorney']               AS law_firm,
    -- The placeholder sets, from lib/professionalIdentity.ts. 'self' is in ph_independent.
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
matches AS (
  SELECT
    p.id,
    -- n***@example.com
    CASE WHEN p.email IS NULL OR position('@' in p.email) = 0 THEN '(no email)'
         ELSE left(p.email, 1) || '***@' || split_part(p.email, '@', 2) END          AS email_masked,
    p.full_name,
    p.role_type,
    p.exact_job_title,
    p.title,
    p.company,
    p.current_status,
    p.account_status,
    p.profile_complete,
    p.is_test_account,
    p.is_admin
  FROM public.profiles p
  WHERE p.full_name ILIKE '%wittenberg%'
     OR p.email     ILIKE '%wittenberg%'
),
classified AS (
  -- norm(): lowercase, punctuation to space, collapse whitespace — same as professionalIdentity.
  -- companySituation(): the SAME order of tests, including the prefix rules. Whole-string matches,
  -- so "Self" is a placeholder while "Self Financial, Inc." is a real employer.
  SELECT
    m.*,
    v.in_house, v.law_firm,
    btrim(regexp_replace(lower(regexp_replace(COALESCE(m.company,''), '[.,/#!$%^&*;:{}=\-_`~()]', ' ', 'g')), '\s+', ' ', 'g')) AS company_norm,
    (btrim(COALESCE(m.role_type,'')) = ANY (v.in_house))                            AS role_is_in_house,
    (btrim(COALESCE(m.role_type,'')) = ANY (v.law_firm))                            AS role_is_law_firm,
    CASE
      WHEN btrim(regexp_replace(lower(regexp_replace(COALESCE(m.company,''), '[.,/#!$%^&*;:{}=\-_`~()]', ' ', 'g')), '\s+', ' ', 'g')) = '' THEN NULL
      WHEN btrim(regexp_replace(lower(regexp_replace(COALESCE(m.company,''), '[.,/#!$%^&*;:{}=\-_`~()]', ' ', 'g')), '\s+', ' ', 'g')) = ANY (v.ph_independent)
        OR btrim(regexp_replace(lower(regexp_replace(COALESCE(m.company,''), '[.,/#!$%^&*;:{}=\-_`~()]', ' ', 'g')), '\s+', ' ', 'g')) ~ '^(independent|freelance|self employed|selfemployed|fractional)\y' THEN 'independent'
      WHEN btrim(regexp_replace(lower(regexp_replace(COALESCE(m.company,''), '[.,/#!$%^&*;:{}=\-_`~()]', ' ', 'g')), '\s+', ' ', 'g')) = ANY (v.ph_stealth)
        OR btrim(regexp_replace(lower(regexp_replace(COALESCE(m.company,''), '[.,/#!$%^&*;:{}=\-_`~()]', ' ', 'g')), '\s+', ' ', 'g')) ~ '^stealth\y' THEN 'stealth'
      WHEN btrim(regexp_replace(lower(regexp_replace(COALESCE(m.company,''), '[.,/#!$%^&*;:{}=\-_`~()]', ' ', 'g')), '\s+', ' ', 'g')) = ANY (v.ph_between)
        OR btrim(regexp_replace(lower(regexp_replace(COALESCE(m.company,''), '[.,/#!$%^&*;:{}=\-_`~()]', ' ', 'g')), '\s+', ' ', 'g')) ~ '^between (roles|jobs)\y' THEN 'between_roles'
      WHEN btrim(regexp_replace(lower(regexp_replace(COALESCE(m.company,''), '[.,/#!$%^&*;:{}=\-_`~()]', ' ', 'g')), '\s+', ' ', 'g')) = ANY (v.ph_retired)      THEN 'retired'
      WHEN btrim(regexp_replace(lower(regexp_replace(COALESCE(m.company,''), '[.,/#!$%^&*;:{}=\-_`~()]', ' ', 'g')), '\s+', ' ', 'g')) = ANY (v.ph_confidential) THEN 'confidential'
      ELSE 'employed'
    END                                                                             AS company_situation
  FROM matches m CROSS JOIN vocab v
),
situated AS (
  -- effectiveSituation(): a stored status wins outright; the company is the legacy fallback only.
  SELECT
    c.*,
    (c.company_situation IS NOT DISTINCT FROM 'employed')                           AS company_is_genuine,
    CASE btrim(COALESCE(c.current_status,''))
      WHEN 'employed'            THEN 'employed'
      WHEN 'between_roles'       THEN 'between_roles'
      WHEN 'consulting_advisory' THEN 'independent'
      WHEN '' THEN CASE c.company_situation
                     WHEN 'independent'   THEN 'independent'
                     WHEN 'between_roles' THEN 'between_roles'
                     WHEN 'employed'      THEN 'employed'
                     ELSE 'unknown'
                   END
      ELSE 'unknown'
    END                                                                             AS effective_situation,
    -- professionalIdentity()'s situation. Same precedence, but it keeps the retired /
    -- confidential / stealth branches that effectiveSituation collapses to 'unknown'.
    CASE btrim(COALESCE(c.current_status,''))
      WHEN 'employed'            THEN 'employed'
      WHEN 'between_roles'       THEN 'between_roles'
      WHEN 'consulting_advisory' THEN 'independent'
      ELSE COALESCE(NULLIF(c.company_situation, 'employed'), 'employed')
    END                                                                             AS render_situation,
    COALESCE(NULLIF(btrim(COALESCE(c.exact_job_title,'')), ''),
             NULLIF(btrim(COALESCE(c.title,'')), ''),
             NULLIF(btrim(COALESCE(c.role_type,'')), ''), '')                       AS shown_title
  FROM classified c
),
shaped AS (
  SELECT
    s.*,
    -- professionalIdentity(): the primary line. The employed branch prints "at <company>" ONLY
    -- for a genuine company, so a placeholder is never dressed up as an employer.
    CASE s.render_situation
      WHEN 'independent'   THEN CASE WHEN s.shown_title = '' THEN 'Independent professional'
                                     WHEN lower(s.shown_title) ~ '^independent\y' THEN s.shown_title
                                     ELSE 'Independent ' || s.shown_title END
      WHEN 'retired'       THEN CASE WHEN s.shown_title = '' THEN 'Retired professional'
                                     WHEN lower(s.shown_title) ~ '^former\y' THEN s.shown_title
                                     ELSE 'Former ' || s.shown_title END
      WHEN 'between_roles' THEN COALESCE(NULLIF(s.shown_title,''), 'Professional')
      WHEN 'confidential'  THEN COALESCE(NULLIF(s.shown_title,''), 'Professional')
      WHEN 'stealth'       THEN COALESCE(NULLIF(s.shown_title,''), 'Professional')
      ELSE CASE WHEN s.shown_title <> '' AND s.company_is_genuine
                  THEN s.shown_title || ' at ' || btrim(s.company)
                WHEN s.shown_title <> '' THEN s.shown_title
                WHEN s.company_is_genuine THEN btrim(s.company)
                ELSE '' END
    END                                                                             AS current_display,
    -- checkRoleEmploymentCompatibility(): the SAME checks in the SAME order.
    CASE
      WHEN btrim(COALESCE(s.role_type,'')) = '' THEN 'no role stored — nothing to contradict'
      WHEN s.role_is_in_house AND s.effective_situation = 'independent'
        THEN 'INCOMPATIBLE: in-house role while presenting as independent/consulting'
      WHEN s.role_is_in_house AND s.effective_situation = 'between_roles'
        THEN 'INCOMPATIBLE: in-house role while between roles'
      WHEN s.role_is_in_house AND NOT s.company_is_genuine
        THEN 'INCOMPATIBLE: in-house role without a genuine employer'
      WHEN s.role_is_in_house THEN 'compatible'
      WHEN s.role_is_law_firm AND s.effective_situation = 'between_roles'
        THEN 'INCOMPATIBLE: law-firm role while between roles'
      WHEN s.role_is_law_firm AND NOT s.company_is_genuine
        THEN 'INCOMPATIBLE: law-firm role without a named firm or solo practice'
      WHEN s.role_is_law_firm THEN 'compatible'
      WHEN btrim(COALESCE(s.current_status,'')) = 'employed' AND NOT s.company_is_genuine
        THEN 'INCOMPATIBLE: employed status without a genuine employer'
      ELSE 'compatible'
    END                                                                             AS compatibility
  FROM situated s
)
SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now(),
  'match_count', (SELECT count(*) FROM shaped),
  'exactly_one_match', (SELECT count(*) FROM shaped) = 1,
  'matches', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', id,
      'email_masked', email_masked,
      'full_name', full_name,
      'role_type', role_type,
      'exact_job_title', exact_job_title,
      'title', title,
      'company', company,
      'current_status', current_status,
      'account_status', account_status,
      'profile_complete', profile_complete,
      'is_test_account', is_test_account,
      'is_admin', is_admin,
      -- The EXACT literals to paste into the repair. The repair refuses while any is left unset,
      -- and refuses again if the row no longer holds these pre-repair values. '(null)' means the
      -- column is NULL or blank today — paste it verbatim, it is a real pin, not a placeholder.
      'pins_to_paste', jsonb_build_object(
        'c_expect_id',        id::text,
        'c_expect_role_type', COALESCE(NULLIF(btrim(COALESCE(role_type,'')),''),'(null)'),
        'c_expect_company',   COALESCE(NULLIF(btrim(COALESCE(company,'')),''),'(null)'),
        'c_expect_job_title', COALESCE(NULLIF(btrim(COALESCE(exact_job_title,'')),''),'(null)'),
        'c_expect_status',    COALESCE(NULLIF(btrim(COALESCE(current_status,'')),''),'(null)')),
      'role_is_in_house', role_is_in_house,
      'role_is_law_firm', role_is_law_firm,
      'company_situation', COALESCE(company_situation, '(empty)'),
      'company_is_genuine', company_is_genuine,
      'effective_situation', effective_situation,
      'render_situation', render_situation,
      'current_display', current_display,
      'target_display', 'Corporate Counsel at Armedia',
      'display_already_correct', current_display = 'Corporate Counsel at Armedia',
      'compatibility', compatibility)
      ORDER BY id) FROM shaped), '[]'::jsonb),
  'reading_notes', jsonb_build_array(
    'If match_count is not 1, DO NOT run the repair — it refuses anyway. Two rows means a duplicate '
      || 'identity to resolve first, zero means the search terms are wrong.',
    'The id is emitted so the repair can pin it. Copy it into the repair''s c_expect_id.',
    'pins_to_paste carries the PRE-REPAIR values the repair verifies before it writes. Paste all '
      || 'five. The repair changes role_type to In-House Counsel regardless of what it finds — the '
      || 'pin exists to prove the row is still the one that was reviewed, not to decide the write.',
    'company_is_genuine uses the SAME placeholder vocabulary as the application. A company of '
      || '"Self", "Independent" or "N/A" is NOT genuine; a real name that merely contains one of '
      || 'those words, such as "Self Financial, Inc.", is.',
    'Email is masked to first character + domain: enough to tell two people apart, not a contact.',
    'No bio, avatar, location, phone, LinkedIn, credits, matches or introductions are read.',
    'current_display is computed by the same precedence the app renders with, so it is what the '
      || 'member''s profile actually shows right now.')
)) AS nicholas_audit;
