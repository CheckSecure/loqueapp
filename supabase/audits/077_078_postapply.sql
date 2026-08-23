-- 077/078/079 POST-APPLY — read-only. Run AFTER applying. Every statement is a SELECT.
-- ONE statement, uniform schema; anything not 'PASS' must be investigated before rollout continues.
SELECT check_name, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS result, detail FROM (VALUES
  ('077: reminder_enrollment_at exists',
   EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='waitlist' AND column_name='reminder_enrollment_at'),
   'prospective enrollment marker'),
  -- The app stamps reminder_enrollment_at and invited_at in ONE update with the SAME value, so a
  -- legitimately enrolled row always has them equal. A backfill — the thing that must never happen —
  -- would set enrollment at some later moment and leave them different. That is a checkable
  -- invariant; "invited before the first reminder was attempted" is NOT, because it is true of every
  -- correctly enrolled row (the reminder comes 24h afterwards) and would fail on healthy data.
  ('077: every enrolled row was stamped at invite time, not backfilled',
   NOT EXISTS (SELECT 1 FROM public.waitlist
                WHERE reminder_enrollment_at IS NOT NULL
                  AND (invited_at IS NULL OR reminder_enrollment_at <> invited_at)),
   'enrollment and invitation must carry the identical timestamp'),
  ('077: enrolled count (expect 0 immediately after apply)',
   true, (SELECT count(*)::text FROM public.waitlist WHERE reminder_enrollment_at IS NOT NULL)),
  ('077: historical invitations left unenrolled',
   true, (SELECT count(*)::text FROM public.waitlist
           WHERE status='invited' AND reminder_enrollment_at IS NULL)
           || ' — these can only be reached by the admin catch-up route'),
  ('077: staged purposes accepted',
   (SELECT pg_get_constraintdef(oid) LIKE '%onboarding_reminder_1%onboarding_reminder_2%onboarding_reminder_3%onboarding_catchup%'
      FROM pg_constraint WHERE conname='invitation_deliveries_purpose_check'),
   'three stages plus the admin catch-up'),
  ('077: legacy purposes preserved',
   (SELECT pg_get_constraintdef(oid) LIKE '%first_invite%access_resend%'
      FROM pg_constraint WHERE conname='invitation_deliveries_purpose_check'),
   'existing rows must stay valid'),
  ('078: resume-token table exists',
   to_regclass('public.invitation_resume_tokens') IS NOT NULL, ''),
  ('078: token hash is bytea',
   (SELECT data_type='bytea' FROM information_schema.columns
     WHERE table_name='invitation_resume_tokens' AND column_name='token_sha256'), 'never text'),
  ('078: 32-byte length constraint present',
   EXISTS (SELECT 1 FROM pg_constraint WHERE conname='invitation_resume_tokens_hash_len'), 'rejects anything but a digest'),
  ('078: token hash is unique',
   EXISTS (SELECT 1 FROM pg_constraint WHERE conname='invitation_resume_tokens_hash_uniq'), ''),
  ('078: MULTIPLE live tokens per invitation are permitted',
   NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='invitation_resume_tokens_live_uniq'),
   'a one-live-token constraint would make each reminder kill the previous email''s link'),
  ('078: auth_user_id is NOT NULL (completion can invalidate)',
   (SELECT is_nullable='NO' FROM information_schema.columns
     WHERE table_name='invitation_resume_tokens' AND column_name='auth_user_id'),
   'a NULL binding made the completion check match no row'),
  ('078: identity resolver exists',
   to_regprocedure('public.lookup_auth_identity(text)') IS NOT NULL,
   'replaces a listUsers() fallback that read only the first 200 identities'),
  ('078: resolver is SECURITY DEFINER with empty search_path',
   (SELECT prosecdef AND 'search_path=""' = ANY(proconfig) FROM pg_proc
     WHERE oid=to_regprocedure('public.lookup_auth_identity(text)')), ''),
  ('078: PUBLIC cannot execute the resolver',
   NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(coalesce(p.proacl,ARRAY[]::aclitem[])) a
                WHERE p.oid=to_regprocedure('public.lookup_auth_identity(text)') AND a::text LIKE '=%'), ''),
  ('078: anon cannot execute the resolver',
   NOT has_function_privilege('anon', to_regprocedure('public.lookup_auth_identity(text)'), 'EXECUTE'), ''),
  ('078: authenticated cannot execute the resolver',
   NOT has_function_privilege('authenticated', to_regprocedure('public.lookup_auth_identity(text)'), 'EXECUTE'), ''),
  ('078: service_role CAN execute the resolver',
   has_function_privilege('service_role', to_regprocedure('public.lookup_auth_identity(text)'), 'EXECUTE'), ''),
  ('078: claim checks identity binding and exact invited status',
   (SELECT prosrc LIKE '%v_authid <> t.auth_user_id%' AND prosrc LIKE '%v_wstatus <> ''invited''%'
      FROM pg_proc WHERE oid=to_regprocedure('public.claim_invitation_resume_request(bytea,integer,integer,integer)')),
   'rejects recreated identities and any non-invited status'),
  ('078: global bucket is touched only after eligibility',
   (SELECT position('FOR UPDATE' in prosrc) < position('invitation_resume_rate' in prosrc)
      FROM pg_proc WHERE oid=to_regprocedure('public.claim_invitation_resume_request(bytea,integer,integer,integer)')),
   'random tokens must not be able to exhaust the global limit'),
  ('077: only ''failed'' is a retryable stage',
   EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='invitation_deliveries_onboarding_stage_uniq'
             AND indexdef LIKE '%status <> ''failed''%'),
   'every other status consumes the stage'),
  ('079: discovery requires a complete, non-test profile',
   (SELECT prosrc LIKE '%tgt.profile_complete IS TRUE%' AND prosrc LIKE '%tgt.is_test_account IS NOT TRUE%'
      FROM pg_proc WHERE proname='can_discover_profile'),
   'a direct predicate, not an inference from what matching would refuse'),
  ('079: the self branch is preserved',
   (SELECT prosrc LIKE '%auth.uid() = member_id%' FROM pg_proc WHERE proname='can_discover_profile'),
   'a member must still see their own row while onboarding'),
  ('078: NO foreign key on the token table',
   -- contype is the internal "char" type. A COMPARISON against an untyped literal is unambiguous
   -- (the literal is resolved to "char"), unlike concatenation — but it is spelled out here so the
   -- one remaining "char" reference in these audits is explicitly typed.
   (SELECT count(*) FROM pg_constraint
     WHERE conrelid=to_regclass('public.invitation_resume_tokens') AND contype = 'f'::"char") = 0,
   'a FK would block the deletion paths it must survive'),
  ('078: no column can hold an email or plaintext',
   NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invitation_resume_tokens'
                 AND column_name ~* 'email|plaintext|secret|password'), ''),
  ('078: RLS enabled on the token table',
   (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.invitation_resume_tokens')), ''),
  ('078: RLS enabled on the rate table',
   (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.invitation_resume_rate')), ''),
  ('078: zero policies on both (no browser access)',
   (SELECT count(*) FROM pg_policies WHERE tablename IN ('invitation_resume_tokens','invitation_resume_rate')) = 0, ''),
  ('078: anon has no privilege on the token table',
   NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                WHERE table_name='invitation_resume_tokens' AND grantee='anon'), ''),
  ('078: authenticated has no privilege on the token table',
   NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                WHERE table_name='invitation_resume_tokens' AND grantee='authenticated'), ''),
  ('078: service_role = SELECT,INSERT,UPDATE exactly',
   (SELECT string_agg(privilege_type,',' ORDER BY privilege_type) FROM information_schema.role_table_grants
     WHERE table_name='invitation_resume_tokens' AND grantee='service_role') = 'INSERT,SELECT,UPDATE',
   'UPDATE is required for rate counters and revocation; DELETE is not granted'),
  ('078: service_role cannot DELETE tokens',
   NOT has_table_privilege('service_role','public.invitation_resume_tokens','DELETE'), 'tokens are revoked, never erased'),
  ('078: service_role cannot TRUNCATE tokens',
   NOT has_table_privilege('service_role','public.invitation_resume_tokens','TRUNCATE'), ''),
  ('078: claim function exists',
   to_regprocedure('public.claim_invitation_resume_request(bytea,integer,integer,integer)') IS NOT NULL, ''),
  ('078: claim function is SECURITY DEFINER with empty search_path',
   (SELECT prosecdef AND 'search_path=""' = ANY(proconfig) FROM pg_proc
     WHERE oid=to_regprocedure('public.claim_invitation_resume_request(bytea,integer,integer,integer)')), ''),
  ('078: PUBLIC cannot execute the claim function',
   NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(coalesce(p.proacl,ARRAY[]::aclitem[])) a
                WHERE p.oid=to_regprocedure('public.claim_invitation_resume_request(bytea,integer,integer,integer)')
                  AND a::text LIKE '=%'),
   'PUBLIC is a pseudo-role: the ACL is inspected, not has_function_privilege'),
  ('078: anon cannot execute the claim function',
   NOT has_function_privilege('anon', to_regprocedure('public.claim_invitation_resume_request(bytea,integer,integer,integer)'), 'EXECUTE'), ''),
  ('078: authenticated cannot execute the claim function',
   NOT has_function_privilege('authenticated', to_regprocedure('public.claim_invitation_resume_request(bytea,integer,integer,integer)'), 'EXECUTE'), ''),
  ('078: service_role CAN execute the claim function',
   has_function_privilege('service_role', to_regprocedure('public.claim_invitation_resume_request(bytea,integer,integer,integer)'), 'EXECUTE'), ''),
  ('078: waitlist-state resolver exists',
   to_regprocedure('public.lookup_waitlist_identity(text)') IS NOT NULL,
   'one normalization contract; replaces an ILIKE pattern match in the initializer'),
  ('078: waitlist resolver is SECURITY DEFINER with empty search_path',
   (SELECT prosecdef AND 'search_path=""' = ANY(proconfig) FROM pg_proc
     WHERE oid=to_regprocedure('public.lookup_waitlist_identity(text)')), ''),
  ('078: browser roles cannot execute the waitlist resolver',
   NOT has_function_privilege('anon', to_regprocedure('public.lookup_waitlist_identity(text)'), 'EXECUTE')
   AND NOT has_function_privilege('authenticated', to_regprocedure('public.lookup_waitlist_identity(text)'), 'EXECUTE')
   AND NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(coalesce(p.proacl,ARRAY[]::aclitem[])) a
                    WHERE p.oid=to_regprocedure('public.lookup_waitlist_identity(text)') AND a::text LIKE '=%'), ''),
  ('078: rotation operations table exists',
   to_regclass('public.invitation_rotation_operations') IS NOT NULL,
   'remembers which replacement token to keep so finalization is resumable'),
  ('078: at most ONE active rotation per invitation',
   EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='invitation_rotation_operations_active_uniq'),
   'the rotation concurrency boundary — releasable, unlike a terminal delivery row'),
  ('078: rotation operations RLS on, zero policies',
   (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.invitation_rotation_operations'))
   AND (SELECT count(*) FROM pg_policies WHERE tablename='invitation_rotation_operations') = 0, ''),
  ('078: rotation operations — browser roles hold nothing',
   NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants
                WHERE table_name='invitation_rotation_operations' AND grantee IN ('anon','authenticated')), ''),
  ('078: rotation operations — service_role has SELECT,INSERT,UPDATE only',
   (SELECT string_agg(privilege_type,',' ORDER BY privilege_type) FROM information_schema.role_table_grants
     WHERE table_name='invitation_rotation_operations' AND grantee='service_role') = 'INSERT,SELECT,UPDATE', ''),
  ('078: rotation operations hold no email or plaintext',
   NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invitation_rotation_operations'
                 AND column_name ~* 'email|plaintext|secret|token_value'), ''),
  ('078: begin_resume_rotation exists (prepare-or-converge)',
   to_regprocedure('public.begin_resume_rotation(uuid,uuid,bytea)') IS NOT NULL, ''),
  ('078: record_resume_rotation_outcome exists (acceptance before finalize)',
   to_regprocedure('public.record_resume_rotation_outcome(uuid,text,uuid,text)') IS NOT NULL, ''),
  ('078: rotation finalizer takes the OPERATION id',
   to_regprocedure('public.finalize_resume_rotation(uuid)') IS NOT NULL,
   'the two-argument form could not resume an interrupted rotation'),
  ('078: finalizer requires acceptance before retiring anything',
   (SELECT prosrc LIKE '%<> ''accepted_pending_finalize''%'
      FROM pg_proc WHERE oid=to_regprocedure('public.finalize_resume_rotation(uuid)')),
   'retiring live links on an unconfirmed send is the failure this order prevents'),
  ('078: finalizer refuses a keeper that is not live for the invitation',
   (SELECT prosrc LIKE '%replacement token is not a live token for this invitation%'
      FROM pg_proc WHERE oid=to_regprocedure('public.finalize_resume_rotation(uuid)')), ''),
  ('078: browser roles cannot execute the rotation functions',
   NOT has_function_privilege('anon', to_regprocedure('public.finalize_resume_rotation(uuid)'), 'EXECUTE')
   AND NOT has_function_privilege('authenticated', to_regprocedure('public.finalize_resume_rotation(uuid)'), 'EXECUTE')
   AND NOT has_function_privilege('anon', to_regprocedure('public.begin_resume_rotation(uuid,uuid,bytea)'), 'EXECUTE')
   AND NOT has_function_privilege('authenticated', to_regprocedure('public.begin_resume_rotation(uuid,uuid,bytea)'), 'EXECUTE'), ''),
  ('077: resume_access and resume_rotation purposes accepted',
   (SELECT pg_get_constraintdef(oid) LIKE '%resume_access%' AND pg_get_constraintdef(oid) LIKE '%resume_rotation%'
      FROM pg_constraint WHERE conname='invitation_deliveries_purpose_check'),
   'rotation reusing access_resend could be blocked forever by an accepted claim'),
  ('077: dispatch_state column exists with a closed vocabulary',
   EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name='invitation_deliveries' AND column_name='dispatch_state')
   AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='invitation_deliveries_dispatch_state_check'),
   'tells "not sent yet" apart from "we do not know"'),
  ('078: atomic resume-access claim exists',
   to_regprocedure('public.claim_resume_access_attempt(uuid,text,integer,integer)') IS NOT NULL,
   'replaces a check-then-insert that raced'),
  ('078: the claim serializes under an advisory transaction lock',
   (SELECT prosrc LIKE '%pg_advisory_xact_lock%' FROM pg_proc
     WHERE oid=to_regprocedure('public.claim_resume_access_attempt(uuid,text,integer,integer)')),
   'resume_access rows carry waitlist_id NULL, so no unique index serializes them'),
  ('077: dispatching is in the closed vocabulary',
   (SELECT pg_get_constraintdef(oid) LIKE '%dispatching%'
      FROM pg_constraint WHERE conname='invitation_deliveries_dispatch_state_check'),
   'the pre-provider marker; a crashed dispatch must not read as never-attempted'),
  ('078: pre-provider marker function exists',
   to_regprocedure('public.begin_resume_dispatch(uuid)') IS NOT NULL, ''),
  ('078: the marker requires exactly one still-pending row',
   (SELECT prosrc LIKE '%GET DIAGNOSTICS v_n = ROW_COUNT%' AND prosrc LIKE '%RETURN v_n = 1%'
      FROM pg_proc WHERE oid=to_regprocedure('public.begin_resume_dispatch(uuid)')),
   'PostgREST reports no error on a zero-row update; ROW_COUNT is the only exact guarantee'),
  ('078: browser roles cannot execute the marker',
   NOT has_function_privilege('anon', to_regprocedure('public.begin_resume_dispatch(uuid)'), 'EXECUTE')
   AND NOT has_function_privilege('authenticated', to_regprocedure('public.begin_resume_dispatch(uuid)'), 'EXECUTE')
   AND NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(coalesce(p.proacl,ARRAY[]::aclitem[])) a
                    WHERE p.oid=to_regprocedure('public.begin_resume_dispatch(uuid)') AND a::text LIKE '=%'), ''),
  ('078: BOTH dispatching and uncertain are non-auto-retryable',
   (SELECT prosrc LIKE '%dispatch_state IN (''dispatching'', ''uncertain'')%'
      FROM pg_proc WHERE oid=to_regprocedure('public.claim_resume_access_attempt(uuid,text,integer,integer)')),
   'the lease may retire only a genuinely pre-dispatch row'),
  ('078: only pending rows are ever retired by the lease',
   (SELECT prosrc LIKE '%coalesce(d.dispatch_state, ''pending'') = ''pending''%'
      FROM pg_proc WHERE oid=to_regprocedure('public.claim_resume_access_attempt(uuid,text,integer,integer)')), ''),
  ('runtime: resume attempts stuck mid-dispatch',
   true, (SELECT count(*)::text FROM public.invitation_deliveries
           WHERE purpose='resume_access' AND status='claimed' AND dispatch_state IN ('dispatching','uncertain'))
         || ' awaiting webhook evidence or admin review (never auto-retried)'),
  ('078: an uncertain attempt is checked BEFORE any time-based branch',
   (SELECT position('uncertain_review' in prosrc) < position('''in_flight''' in prosrc) FROM pg_proc
     WHERE oid=to_regprocedure('public.claim_resume_access_attempt(uuid,text,integer,integer)')),
   'elapsed time must never convert "we do not know" into a fresh claim'),
  ('078: claim is SECURITY DEFINER with empty search_path',
   (SELECT prosecdef AND 'search_path=""' = ANY(proconfig) FROM pg_proc
     WHERE oid=to_regprocedure('public.claim_resume_access_attempt(uuid,text,integer,integer)')), ''),
  ('078: browser roles cannot execute the claim',
   NOT has_function_privilege('anon', to_regprocedure('public.claim_resume_access_attempt(uuid,text,integer,integer)'), 'EXECUTE')
   AND NOT has_function_privilege('authenticated', to_regprocedure('public.claim_resume_access_attempt(uuid,text,integer,integer)'), 'EXECUTE')
   AND NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(coalesce(p.proacl,ARRAY[]::aclitem[])) a
                    WHERE p.oid=to_regprocedure('public.claim_resume_access_attempt(uuid,text,integer,integer)')
                      AND a::text LIKE '=%'), ''),
  ('runtime: no uncertain resume attempt is silently stuck',
   true, (SELECT count(*)::text FROM public.invitation_deliveries
           WHERE purpose='resume_access' AND status='claimed' AND dispatch_state='uncertain')
         || ' awaiting webhook evidence or admin review (never auto-retried)'),
  ('runtime: EVERY token row is bound to an auth identity',
   NOT EXISTS (SELECT 1 FROM public.invitation_resume_tokens WHERE auth_user_id IS NULL),
   'an unbound token could never be invalidated by profile completion'),
  ('runtime: live tokens per invitation (multiple is EXPECTED)',
   true, coalesce((SELECT max(c)::text FROM (
           SELECT count(*) c FROM public.invitation_resume_tokens
            WHERE revoked_at IS NULL AND superseded_at IS NULL AND waitlist_id IS NOT NULL
            GROUP BY waitlist_id) x), '0')
         || ' — reminders ADD tokens; only an admin rotation retires them'),
  ('runtime: no token row holds anything but a 32-byte digest',
   NOT EXISTS (SELECT 1 FROM public.invitation_resume_tokens WHERE octet_length(token_sha256) <> 32), ''),
  ('runtime: enrolled invitations so far',
   true, (SELECT count(*)::text FROM public.waitlist WHERE reminder_enrollment_at IS NOT NULL)
           || ' (expected 0 immediately after apply — enrollment happens on the next first invite)'),
  ('runtime: staged reminders sent so far',
   true, (SELECT count(*)::text FROM public.invitation_deliveries WHERE purpose LIKE 'onboarding_reminder_%')
           || ' (expected 0 until the daily worker runs with INVITATIONS_MODE=on)')
) t(check_name, ok, detail) ORDER BY check_name;
