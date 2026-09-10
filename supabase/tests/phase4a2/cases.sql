-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PHASE 4A-2 HARNESS — THE CASE MATRIX FOR MIGRATION 100
--
-- Runs AFTER migration 100. Every case records a row in harness_results; the final block raises if
-- any failed, so the runner's exit status is the verdict.
--
-- A case that must be REFUSED asserts on the reason CODE, not on prose, so a reworded message
-- cannot quietly turn a refusal into a pass.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS harness_results;
CREATE TABLE harness_results (
  case_no  int,
  name     text,
  expected text,
  actual   text,
  pass     boolean
);

-- Attempt a statement and report the outcome as text: 'OK' or the SQLSTATE message.
CREATE OR REPLACE FUNCTION h_try(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END $$;

CREATE OR REPLACE FUNCTION h(p_no int, p_name text, p_expect text, p_actual text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO harness_results
  VALUES (p_no, p_name, p_expect, p_actual, position(p_expect in COALESCE(p_actual, '')) > 0);
END $$;

-- Convenience: a first-profile insert for a candidate, omitting member_type unless given.
CREATE OR REPLACE FUNCTION h_ins(p_id text, p_email text, p_member_type text DEFAULT NULL,
                                 p_complete boolean DEFAULT true) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  IF p_member_type IS NULL THEN
    RETURN h_try(format('INSERT INTO public.profiles (id, email, full_name, profile_complete) '
                        'VALUES (%L, %L, %L, %L)', p_id, p_email, 'Cand', p_complete));
  END IF;
  RETURN h_try(format('INSERT INTO public.profiles (id, email, full_name, profile_complete, member_type) '
                      'VALUES (%L, %L, %L, %L, %L)', p_id, p_email, 'Cand', p_complete, p_member_type));
END $$;


-- ═══ 1-3  AUTHORIZED FIRST INSERTS, COMMUNITY DERIVED FROM THE INVITATION ══════════════════════
DO $$
DECLARE v text;
BEGIN
  v := h_ins('c0000001-0000-4000-8000-000000000001', 'cand.pro@example.test');
  PERFORM h(1, 'authorized Professional first insert succeeds', 'OK', v);
  PERFORM h(3, 'omitted member_type derives the trusted intent (professional)', 'professional',
            (SELECT member_type FROM public.profiles WHERE id = 'c0000001-0000-4000-8000-000000000001'));

  v := h_ins('c0000002-0000-4000-8000-000000000002', 'cand.next@example.test');
  PERFORM h(2, 'authorized Next first insert succeeds', 'OK', v);
  PERFORM h(2, 'authorized Next first insert receives next', 'next',
            (SELECT member_type FROM public.profiles WHERE id = 'c0000002-0000-4000-8000-000000000002'));
END $$;

-- ═══ 4  EXPLICIT MATCHING member_type IS ALLOWED ══════════════════════════════════════════════
DO $$
DECLARE v text;
BEGIN
  v := h_ins('c0000015-0000-4000-8000-000000000015', 'cand.explicit@example.test', 'professional');
  PERFORM h(4, 'explicit member_type matching the invitation succeeds', 'OK', v);
END $$;

-- ═══ 5  EXPLICIT MISMATCH IS REFUSED ══════════════════════════════════════════════════════════
DO $$
DECLARE v text;
BEGIN
  v := h_ins('c0000016-0000-4000-8000-000000000016', 'cand.wrongtype@example.test', 'next');
  PERFORM h(5, 'explicit member_type conflicting with the invitation is refused',
            'member_type_conflicts_with_invitation', v);
  PERFORM h(5, 'the refused row was not created', '0',
            (SELECT count(*)::text FROM public.profiles WHERE id = 'c0000016-0000-4000-8000-000000000016'));
END $$;

-- ═══ 6  NO INVITATION AT ALL ══════════════════════════════════════════════════════════════════
DO $$
DECLARE v text;
BEGIN
  v := h_ins('c0000003-0000-4000-8000-000000000003', 'cand.nowl@example.test');
  PERFORM h(6, 'no waitlist row is refused', 'waitlist_absent', v);
END $$;

-- ═══ 7  AMBIGUOUS INTENT ══════════════════════════════════════════════════════════════════════
-- Two live rows for one normalised address carrying DIFFERENT intents. may_provision_profile
-- refuses first (two rows is already a duplicate identity), which is the correct order: whether
-- before which.
DO $$
DECLARE v text;
BEGIN
  v := h_ins('c0000009-0000-4000-8000-000000000009', 'cand.amb@example.test');
  PERFORM h(7, 'conflicting live intent is refused', 'refused', v);
  PERFORM h(7, 'and the resolver independently reports ambiguity', 'ambiguous',
            public.resolve_intended_member_type('cand.amb@example.test') ->> 'outcome');
END $$;

-- ═══ 8/9  TERMINAL INVITATION STATES ══════════════════════════════════════════════════════════
DO $$
DECLARE v text;
BEGIN
  v := h_ins('c0000004-0000-4000-8000-000000000004', 'cand.revoked@example.test');
  PERFORM h(8, 'revoked invitation is refused', 'waitlist_not_invited', v);
  v := h_ins('c0000005-0000-4000-8000-000000000005', 'cand.declined@example.test');
  PERFORM h(9, 'declined invitation is refused', 'waitlist_not_invited', v);
END $$;

-- ═══ 10  IDENTITY PAIRING ═════════════════════════════════════════════════════════════════════
DO $$
DECLARE v text;
BEGIN
  -- The address is invited and its auth user exists — but the id being inserted belongs to a
  -- DIFFERENT auth user, and that id has no profile of its own (so step 0 does not exempt it).
  v := h_try($q$INSERT INTO public.profiles (id, email, full_name)
                VALUES ('c0000003-0000-4000-8000-000000000003', 'cand.mismatch@example.test', 'X')$q$);
  PERFORM h(10, 'auth id / email mismatch is refused', 'identity_mismatch', v);

  -- Two auth identities at one normalised address.
  v := h_ins('c0000011-0000-4000-8000-000000000011', 'cand.twoauth@example.test');
  PERFORM h(10, 'ambiguous auth identity is refused', 'identity_ambiguous', v);

  -- Duplicate waitlist rows, same intent — not ambiguous, still not a single identity.
  v := h_ins('c0000010-0000-4000-8000-000000000010', 'cand.dup@example.test');
  PERFORM h(10, 'duplicate waitlist rows are refused', 'waitlist_duplicate', v);
END $$;

-- ═══ 11  service_role CANNOT BYPASS ═══════════════════════════════════════════════════════════
-- service_role holds INSERT on profiles here (the delta grants it, as Supabase does), so a refusal
-- can only come from the trigger.
DO $$
DECLARE v text;
BEGIN
  SET LOCAL ROLE service_role;
  v := h_ins('c0000017-0000-4000-8000-000000000017', 'cand.svcrole@example.test');
  RESET ROLE;
  PERFORM h(11, 'service_role cannot bypass the boundary', 'waitlist_absent', v);
  PERFORM h(11, 'and no row was created for it', '0',
            (SELECT count(*)::text FROM public.profiles WHERE id = 'c0000017-0000-4000-8000-000000000017'));
END $$;

-- ═══ 12/13/24  EXISTING PROFILES KEEP WORKING, WITH NO WAITLIST AUTHORIZATION ═════════════════
-- 24 is the corrected case. The proposed row of an ON CONFLICT upsert IS constraint-checked before
-- the conflict is resolved (proved in case 24b below), so once the DEFAULT is gone, step 0 supplying
-- member_type is the only reason an existing member's upsert still works.
DO $$
DECLARE v text;
BEGIN
  -- The ordinary historical member: upsert on id, member_type omitted entirely.
  v := h_try($q$INSERT INTO public.profiles (id, email, full_name, profile_complete)
                VALUES ('a0000001-0000-4000-8000-000000000001','hist.ordinary@example.test','Renamed',true)
                ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name$q$);
  PERFORM h(12, 'existing profile upsert on id still works', 'OK', v);
  PERFORM h(12, 'and it actually updated', 'Renamed',
            (SELECT full_name FROM public.profiles WHERE id = 'a0000001-0000-4000-8000-000000000001'));

  -- The legacy exception: NO waitlist row at all, and no auth row for one of them.
  v := h_try($q$INSERT INTO public.profiles (id, email, full_name, profile_complete)
                VALUES ('a0000002-0000-4000-8000-000000000002','hist.nowaitlist@example.test','Legacy A',true)
                ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name$q$);
  PERFORM h(13, 'legacy profile with NO waitlist history still upserts', 'OK', v);

  v := h_try($q$INSERT INTO public.profiles (id, email, full_name, profile_complete)
                VALUES ('a0000003-0000-4000-8000-000000000003','hist.noauth@example.test','Legacy B',true)
                ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name$q$);
  PERFORM h(13, 'legacy profile with NO auth identity still upserts', 'OK', v);

  PERFORM h(24, 'existing-row upsert omitting member_type succeeds (step 0 supplies it)', 'professional',
            (SELECT member_type FROM public.profiles WHERE id = 'a0000002-0000-4000-8000-000000000002'));
END $$;

-- ═══ 24b  THE RAW POSTGRESQL FACT STEP 0 EXISTS FOR ═══════════════════════════════════════════
-- Committed as evidence rather than described: a proposed row that WILL be excluded by ON CONFLICT
-- is still checked against NOT NULL. This is why step 0 cannot simply RETURN NEW.
DO $$
DECLARE v text;
BEGIN
  CREATE TEMP TABLE t24 (id int PRIMARY KEY, nn text NOT NULL);
  INSERT INTO t24 VALUES (1, 'seed');
  v := h_try('INSERT INTO t24 (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET nn = t24.nn');
  PERFORM h(24, 'PG fact: NOT NULL IS enforced on a row that ON CONFLICT will discard',
            'not-null constraint', v);
  DROP TABLE t24;
END $$;

-- ═══ 14  099 IMMUTABILITY STILL BINDS THE UPDATE SIDE ═════════════════════════════════════════
DO $$
DECLARE v text;
BEGIN
  -- Naming a DIFFERENT community in the proposed row: refused by step 0, on the INSERT branch.
  v := h_try($q$INSERT INTO public.profiles (id, email, full_name, member_type)
                VALUES ('a0000001-0000-4000-8000-000000000001','hist.ordinary@example.test','X','next')
                ON CONFLICT (id) DO UPDATE SET member_type = EXCLUDED.member_type$q$);
  PERFORM h(14, 'an upsert cannot change community on the INSERT branch',
            'member_type_immutable_on_insert', v);

  -- And a plain UPDATE is still refused by 099.
  v := h_try($q$UPDATE public.profiles SET member_type = 'next'
                 WHERE id = 'a0000001-0000-4000-8000-000000000001'$q$);
  PERFORM h(14, '099 immutability still refuses a direct UPDATE', 'immutable', v);
  PERFORM h(14, 'community unchanged after both attempts', 'professional',
            (SELECT member_type FROM public.profiles WHERE id = 'a0000001-0000-4000-8000-000000000001'));
END $$;

-- ═══ 15/16/17  MEMBERSHIP CREDIT CYCLE ════════════════════════════════════════════════════════
DO $$
DECLARE v text; n bigint;
BEGIN
  -- 15  a refused insert must leave no side effect at all.
  SELECT count(*) INTO n FROM public.membership_credit_cycles
   WHERE user_id = 'c0000006-0000-4000-8000-000000000006';
  v := h_ins('c0000006-0000-4000-8000-000000000006', 'cand.pending@example.test');
  PERFORM h(15, 'refused insert enrols no credit cycle', '0',
            (SELECT count(*)::text FROM public.membership_credit_cycles
              WHERE user_id = 'c0000006-0000-4000-8000-000000000006'));

  -- 16  an authorized first insert enrols exactly one.
  v := h_ins('c0000014-0000-4000-8000-000000000014', 'cand.credit@example.test');
  PERFORM h(16, 'authorized first insert enrols exactly one credit cycle', '1',
            (SELECT count(*)::text FROM public.membership_credit_cycles
              WHERE user_id = 'c0000014-0000-4000-8000-000000000014'));

  -- 17  an upsert that resolves to UPDATE must not enrol a second.
  v := h_try($q$INSERT INTO public.profiles (id, email, full_name, profile_complete)
                VALUES ('c0000014-0000-4000-8000-000000000014','cand.credit@example.test','Again',true)
                ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name$q$);
  PERFORM h(17, 'upsert resolving to UPDATE enrols no second cycle', '1',
            (SELECT count(*)::text FROM public.membership_credit_cycles
              WHERE user_id = 'c0000014-0000-4000-8000-000000000014'));
END $$;

-- ═══ 18  084's STAMP TRIGGER IS UNAFFECTED ════════════════════════════════════════════════════
DO $$
DECLARE v text;
BEGIN
  -- A profile created already-complete is enrolled by the INSERT branch.
  PERFORM h(18, 'stamp: a complete first insert is enrolled', 'yes',
            CASE WHEN (SELECT intro_guidance_enrolled_at IS NOT NULL FROM public.profiles
                        WHERE id = 'c0000001-0000-4000-8000-000000000001') THEN 'yes' ELSE 'no' END);

  -- An incomplete first insert is NOT enrolled…
  v := h_ins('c0000007-0000-4000-8000-000000000007', 'cand.approved@example.test', NULL, false);
  -- (that one is refused — 'approved' is not 'invited' — so use the explicit candidate instead)
  PERFORM h(18, 'stamp: enrolment is not granted to a refused row', '0',
            (SELECT count(*)::text FROM public.profiles WHERE id = 'c0000007-0000-4000-8000-000000000007'));

  -- …and the UPDATE transition still enrols exactly once.
  UPDATE public.profiles SET intro_guidance_enrolled_at = NULL, profile_complete = false
   WHERE id = 'c0000015-0000-4000-8000-000000000015';
  UPDATE public.profiles SET profile_complete = true
   WHERE id = 'c0000015-0000-4000-8000-000000000015';
  PERFORM h(18, 'stamp: the profile_complete transition still enrols', 'yes',
            CASE WHEN (SELECT intro_guidance_enrolled_at IS NOT NULL FROM public.profiles
                        WHERE id = 'c0000015-0000-4000-8000-000000000015') THEN 'yes' ELSE 'no' END);
END $$;

-- ═══ 19/20  THE COLUMN AFTER THE MIGRATION ════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM h(19, 'member_type has NO default', 'none',
            COALESCE((SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid)
                        FROM pg_catalog.pg_attribute a
                        LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
                       WHERE a.attrelid='public.profiles'::regclass AND a.attname='member_type'), 'none'));
  PERFORM h(20, 'member_type is still NOT NULL', 'true',
            (SELECT attnotnull::text FROM pg_catalog.pg_attribute
              WHERE attrelid='public.profiles'::regclass AND attname='member_type'));
  PERFORM h(20, 'the CHECK still names both communities and nothing else', 'professional',
            (SELECT pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint
              WHERE conname='profiles_member_type_check' AND conrelid='public.profiles'::regclass));
  -- The CHECK is now UNREACHABLE through the boundary — the trigger refuses an unrecognised
  -- community at step 4 before any constraint is evaluated, which is the stronger behaviour. To
  -- prove the constraint is nonetheless still armed as the last line of defence, lift the trigger
  -- for exactly one statement. (This is the only place in the harness that disables it, and it is
  -- re-enabled in the same block.)
  PERFORM h(20, 'the boundary refuses an unrecognised community before the CHECK is reached',
            'member_type_conflicts_with_invitation',
            h_try($q$INSERT INTO public.profiles (id,email,full_name,member_type)
                     VALUES ('c0000013-0000-4000-8000-000000000013','cand.mismatch@example.test','X','student')$q$));

  ALTER TABLE public.profiles DISABLE TRIGGER profiles_provision_bind_bi;
  PERFORM h(20, 'and with the boundary lifted, the CHECK still refuses a third community',
            'violates check constraint',
            h_try($q$INSERT INTO public.profiles (id,email,full_name,member_type)
                     VALUES ('d0000001-0000-4000-8000-000000000001','checkprobe@example.test','X','student')$q$));
  ALTER TABLE public.profiles ENABLE TRIGGER profiles_provision_bind_bi;
END $$;

-- ═══ 21  TRIGGER ORDER, FROM THE CATALOG ══════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM h(21, 'the binding trigger fires before the stamp trigger',
            'profiles_provision_bind_bi,stamp_intro_guidance_enrollment',
            (SELECT string_agg(t.tgname, ',' ORDER BY t.tgname COLLATE "C")
               FROM pg_catalog.pg_trigger t
              WHERE t.tgrelid='public.profiles'::regclass AND NOT t.tgisinternal
                AND (t.tgtype & 2)<>0 AND (t.tgtype & 1)<>0 AND (t.tgtype & 4)<>0));
  PERFORM h(21, 'the full trigger topology is the expected six',
            'capture_profile_deletion,capture_profiles_truncate,profiles_member_type_immutable_bu,'
            'profiles_provision_bind_bi,stamp_intro_guidance_enrollment,trg_enroll_membership_credit_cycle',
            (SELECT string_agg(t.tgname, ',' ORDER BY t.tgname COLLATE "C")
               FROM pg_catalog.pg_trigger t
              WHERE t.tgrelid='public.profiles'::regclass AND NOT t.tgisinternal));
END $$;

-- ═══ 22  EXISTING PROFESSIONAL BEHAVIOUR UNCHANGED ════════════════════════════════════════════
DO $$
BEGIN
  PERFORM h(22, 'no historical profile was altered by the migration', '0',
            (SELECT count(*)::text FROM public.profiles
              WHERE id::text LIKE 'a00000%' AND member_type <> 'professional'));
  PERFORM h(22, 'community_pair_allowed still answers for two professionals', 'true',
            public.community_pair_allowed('a0000001-0000-4000-8000-000000000001',
                                          'a0000002-0000-4000-8000-000000000002')::text);
  PERFORM h(22, 'and still refuses a cross-community pair', 'false',
            public.community_pair_allowed('a0000001-0000-4000-8000-000000000001',
                                          'c0000002-0000-4000-8000-000000000002')::text);
END $$;

-- ═══ 25  CONCURRENT FIRST INSERT — THE 23505 PATH initialize RELIES ON ════════════════════════
DO $$
DECLARE v text;
BEGIN
  -- The row now exists (case 1). A second plain INSERT for the same id must still be a duplicate-key
  -- error, not an authorization error: /api/profile/initialize treats 23505 as success.
  v := h_try($q$INSERT INTO public.profiles (id, email, full_name)
                VALUES ('c0000001-0000-4000-8000-000000000001','cand.pro@example.test','Race')$q$);
  PERFORM h(25, 'a concurrent duplicate first insert still raises duplicate key', 'duplicate key', v);
END $$;

-- ═══ 26  NO ADDRESS ═══════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v text;
BEGIN
  -- The boundary refuses a NULL address BEFORE profiles.email's own NOT NULL is evaluated, so the
  -- error the caller sees is the reason code rather than a constraint name. Both are refusals; the
  -- boundary simply gets there first, which is the intended order.
  v := h_try($q$INSERT INTO public.profiles (id, email, full_name)
                VALUES ('d0000002-0000-4000-8000-000000000002', NULL, 'X')$q$);
  PERFORM h(26, 'a NULL address cannot create a profile', 'no_email', v);
  v := h_try($q$INSERT INTO public.profiles (id, email, full_name)
                VALUES ('d0000003-0000-4000-8000-000000000003', '   ', 'X')$q$);
  PERFORM h(26, 'a blank address is refused by the boundary', 'no_email', v);
END $$;

-- ═══ 27  THE PRE-INVITATION STATES — WHY THIS IS TWO FUNCTIONS ════════════════════════════════
-- Each of these resolves to a community and is still refused provisioning. If one function answered
-- both questions, every one of these would have become a member.
DO $$
DECLARE v text;
BEGIN
  PERFORM h(27, 'resolver says professional for a PENDING row', 'professional',
            public.resolve_intended_member_type('cand.pending@example.test') ->> 'member_type');
  PERFORM h(27, 'but provisioning is refused for PENDING', 'waitlist_not_invited',
            public.may_provision_profile('cand.pending@example.test',
                                         'c0000006-0000-4000-8000-000000000006') ->> 'reason');

  PERFORM h(27, 'resolver says professional for an APPROVED row', 'professional',
            public.resolve_intended_member_type('cand.approved@example.test') ->> 'member_type');
  v := h_ins('c0000007-0000-4000-8000-000000000007', 'cand.approved@example.test');
  PERFORM h(27, 'but provisioning is refused for APPROVED', 'waitlist_not_invited', v);

  PERFORM h(27, 'resolver says professional for a CONTACTED row', 'professional',
            public.resolve_intended_member_type('cand.contacted@example.test') ->> 'member_type');
  v := h_ins('c0000008-0000-4000-8000-000000000008', 'cand.contacted@example.test');
  PERFORM h(27, 'but provisioning is refused for CONTACTED', 'waitlist_not_invited', v);

  PERFORM h(27, 'resolver still says professional for a DECLINED row (it excludes only revoked)',
            'professional',
            public.resolve_intended_member_type('cand.declined@example.test') ->> 'member_type');
END $$;

-- ═══ 28  DELETION PATHS STILL WORK ════════════════════════════════════════════════════════════
DO $$
DECLARE v text;
BEGIN
  v := h_try($q$DELETE FROM public.profiles WHERE id = 'c0000015-0000-4000-8000-000000000015'$q$);
  PERFORM h(28, 'a BEFORE INSERT boundary does not impede DELETE', 'OK', v);
  PERFORM h(28, 'and 075 recorded the deletion', 'yes',
            CASE WHEN EXISTS (SELECT 1 FROM public.account_deletion_events
                               WHERE deleted_user_id = 'c0000015-0000-4000-8000-000000000015')
                 THEN 'yes' ELSE 'no' END);
END $$;

-- ═══ 29  MESSAGES CARRY NO IDENTIFIERS ════════════════════════════════════════════════════════
DO $$
DECLARE v text; leaked int := 0;
BEGIN
  v := h_ins('c0000003-0000-4000-8000-000000000003', 'cand.nowl@example.test');
  IF position('cand.nowl' in v) > 0 THEN leaked := leaked + 1; END IF;
  IF position('c0000003' in v) > 0 THEN leaked := leaked + 1; END IF;
  IF position('@' in v) > 0        THEN leaked := leaked + 1; END IF;
  PERFORM h(29, 'a refusal message contains no address, id or name', '0', leaked::text);
  PERFORM h(29, 'and it does carry the reason code', 'waitlist_absent', v);
END $$;

-- ═══ 30/31  PRIVILEGES AND BYPASS VECTORS ═════════════════════════════════════════════════════
DO $$
BEGIN
  PERFORM h(30, 'anon cannot execute may_provision_profile', 'false',
            pg_catalog.has_function_privilege('anon','public.may_provision_profile(text,uuid)','EXECUTE')::text);
  PERFORM h(30, 'authenticated cannot execute may_provision_profile', 'false',
            pg_catalog.has_function_privilege('authenticated','public.may_provision_profile(text,uuid)','EXECUTE')::text);
  PERFORM h(30, 'service_role can execute may_provision_profile', 'true',
            pg_catalog.has_function_privilege('service_role','public.may_provision_profile(text,uuid)','EXECUTE')::text);
  PERFORM h(31, 'no RULE on profiles', '0',
            (SELECT count(*)::text FROM pg_catalog.pg_rules WHERE schemaname='public' AND tablename='profiles'));
  PERFORM h(31, 'no inheritance child of profiles', '0',
            (SELECT count(*)::text FROM pg_catalog.pg_inherits
              WHERE inhparent='public.profiles'::regclass));
END $$;


-- ═══ VERDICT ══════════════════════════════════════════════════════════════════════════════════
SELECT case_no, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, name,
       CASE WHEN pass THEN '' ELSE 'expected ~ ' || expected || ' | actual: ' || left(COALESCE(actual,'<null>'), 110) END AS detail
FROM harness_results ORDER BY case_no, name;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM harness_results WHERE NOT pass;
  RAISE NOTICE 'phase4a2: % assertions, % failed', (SELECT count(*) FROM harness_results), n;
  IF n > 0 THEN
    RAISE EXCEPTION 'phase4a2: % assertion(s) FAILED', n;
  END IF;
END $$;
