-- 077/078/079 PREFLIGHT — read-only. Run BEFORE applying. Every statement is a SELECT.
-- Supabase renders only the final statement, so this is ONE statement with a uniform schema.
SELECT check_name, result, detail FROM (
  SELECT '1. waitlist exists' AS check_name,
         CASE WHEN to_regclass('public.waitlist') IS NULL THEN 'BLOCKER' ELSE 'ok' END AS result,
         'required by 077' AS detail
  UNION ALL SELECT '2. invitation_deliveries exists',
    CASE WHEN to_regclass('public.invitation_deliveries') IS NULL THEN 'BLOCKER' ELSE 'ok' END,
    'required by 077'
  UNION ALL SELECT '3. reminder_enrollment_at already present',
    CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_name='waitlist' AND column_name='reminder_enrollment_at')
         THEN 'already applied' ELSE 'ok (will be added)' END,
    'ADD COLUMN IF NOT EXISTS — safe either way'
  UNION ALL SELECT '4. rows that would be enrolled by a backfill',
    'INFO',
    (SELECT count(*)::text FROM public.waitlist WHERE status='invited')
      || ' invited rows exist. 077 performs NO backfill: every one stays NULL and therefore OUTSIDE '
      || 'automatic reminders. Confirm this is intended before applying.'
  UNION ALL SELECT '5. current purpose vocabulary',
    'INFO',
    coalesce((SELECT string_agg(DISTINCT purpose, ', ' ORDER BY purpose) FROM public.invitation_deliveries), '(none)')
  UNION ALL SELECT '6. active-claim index present (the dedupe primitive)',
    CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='invitation_deliveries_active_claim_uniq')
         THEN 'ok' ELSE 'BLOCKER' END,
    'per-stage dedupe depends on it'
  UNION ALL SELECT '7. resume-token tables already present',
    CASE WHEN to_regclass('public.invitation_resume_tokens') IS NULL THEN 'ok (will be created)' ELSE 'already applied' END,
    'CREATE TABLE IF NOT EXISTS — safe either way'
  UNION ALL SELECT '8. pgcrypto/gen_random_uuid available',
    CASE WHEN to_regprocedure('gen_random_uuid()') IS NULL THEN 'BLOCKER' ELSE 'ok' END,
    'both migrations use it for defaults'
  UNION ALL SELECT '9. inherited default privileges in schema public',
    'INFO',
    -- defaclobjtype is PostgreSQL's internal "char" type, NOT text or character(1). Concatenating
    -- it directly is ambiguous — both `anynonarray || text` and `text || anynonarray` match, so the
    -- planner refuses with 42725 "operator is not unique" rather than guessing. An explicit ::text
    -- resolves it. Every other operand here is already text: pg_get_userbyid returns name (which has
    -- an unambiguous text concatenation) and array_to_string returns text.
    coalesce((SELECT string_agg(pg_get_userbyid(d.defaclrole)::text || ':' || d.defaclobjtype::text
                                || '=' || array_to_string(d.defaclacl, ' '), ' | ')
                FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname='public'), '(none)')
      || '  -- if non-empty, the REVOKE ALL statements in 078 are doing real work'
  UNION ALL SELECT '10. auth.users readable (the resolver reads it)',
    CASE WHEN to_regclass('auth.users') IS NULL THEN 'BLOCKER' ELSE 'ok' END, 'required by 078'
  UNION ALL SELECT '11. can_discover_profile exists (079 replaces it)',
    CASE WHEN to_regprocedure('public.can_discover_profile(uuid)') IS NULL THEN 'BLOCKER' ELSE 'ok' END,
    '079 rewrites it; the relationship clauses are transcribed unchanged'
  UNION ALL SELECT '12. profiles that would LOSE discoverability under 079',
    'INFO',
    (SELECT count(*)::text FROM public.profiles WHERE profile_complete IS DISTINCT FROM true OR is_test_account IS TRUE)
      || ' incomplete/test profiles. Under 079 these stop being discoverable to other members even '
      || 'if historical match/intro rows exist. Self-view is unaffected. Confirm before applying.'
  UNION ALL SELECT '13. incomplete profiles that ALREADY have relationship rows',
    'INFO',
    (SELECT count(*)::text FROM public.profiles p
      WHERE p.profile_complete IS DISTINCT FROM true
        AND (EXISTS (SELECT 1 FROM public.matches m WHERE m.user_a_id=p.id OR m.user_b_id=p.id)
          OR EXISTS (SELECT 1 FROM public.intro_requests ir WHERE ir.requester_id=p.id OR ir.target_user_id=p.id)))
      || ' — these are exactly the rows the transitive argument did not cover'
) t ORDER BY check_name;
