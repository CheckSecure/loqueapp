#!/usr/bin/env bash
# Migrations 077 + 078 against a real PostgreSQL cluster that REPRODUCES SUPABASE'S INHERITED
# DEFAULT PRIVILEGES on both TABLES and FUNCTIONS. A bare cluster has neither, which is exactly why
# ACL defects here have reached production repeatedly. Cluster is destroyed on exit.
set -euo pipefail
PGBIN=/opt/homebrew/opt/postgresql@17/bin
DATA=$(mktemp -d)/pg78; PORT=55478
export PGHOST=127.0.0.1 PGPORT=$PORT PGDATABASE=postgres
cleanup(){ "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c listen_addresses=127.0.0.1" -l "$DATA/log" -w start >/dev/null
PSQL=("$PGBIN/psql" -U postgres -v ON_ERROR_STOP=1 -X -q)
q(){ "${PSQL[@]}" -tAc "$1"; }
fail=0
chk(){ if [ "$2" = "$3" ]; then printf '  ok   %-62s %s\n' "$1" "$3"
       else printf '  FAIL %-62s expected=%s actual=%s\n' "$1" "$2" "$3"; fail=1; fi; }

"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, last_sign_in_at timestamptz);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, profile_complete boolean,
                              onboarding_step int, updated_at timestamptz, is_admin boolean DEFAULT false,
                              is_test_account boolean DEFAULT false, account_status text DEFAULT 'active');
CREATE TABLE public.waitlist (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, full_name text,
                              status text, invited_at timestamptz,
                              invite_reminder_1_sent_at timestamptz, invite_reminder_2_sent_at timestamptz);
CREATE TABLE public.blocked_users (user_id uuid, blocked_user_id uuid);
CREATE TABLE public.matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_a_id uuid, user_b_id uuid, status text DEFAULT 'active');
CREATE TABLE public.intro_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requester_id uuid, target_user_id uuid, status text, is_admin_initiated boolean DEFAULT false);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT current_setting('test.uid', true)::uuid$$;
CREATE TABLE public.invitation_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), waitlist_id uuid NULL, auth_user_id uuid NULL,
  recipient_email text NOT NULL, purpose text NOT NULL, provider_message_id text, attempt_number int,
  status text NOT NULL DEFAULT 'claimed', error_class text, attempted_at timestamptz DEFAULT now());
ALTER TABLE public.invitation_deliveries ADD CONSTRAINT invitation_deliveries_purpose_check
  CHECK (purpose IN ('first_invite','access_resend','reminder'));
CREATE UNIQUE INDEX invitation_deliveries_active_claim_uniq
  ON public.invitation_deliveries (waitlist_id, purpose)
  WHERE status IN ('claimed','accepted','deferred') AND waitlist_id IS NOT NULL;
SQL

"${PSQL[@]}" -f supabase/migrations/077_onboarding_reminder_stages.sql >/dev/null
"${PSQL[@]}" -f supabase/migrations/078_invitation_resume_tokens.sql >/dev/null
"${PSQL[@]}" -f supabase/migrations/079_discovery_requires_complete_profile.sql >/dev/null
echo "  077 + 078 + 079 applied under Supabase-style default privileges"

echo "── 1. inherited privileges did not survive ──"
for t in invitation_resume_tokens invitation_resume_rate; do
  for r in anon authenticated; do
    chk "$t: $r has NO privilege" "" \
      "$(q "SELECT string_agg(privilege_type,',') FROM information_schema.role_table_grants WHERE table_name='$t' AND grantee='$r'")"
  done
  chk "$t: service_role = INSERT,SELECT,UPDATE" "INSERT,SELECT,UPDATE" \
    "$(q "SELECT string_agg(privilege_type,',' ORDER BY privilege_type) FROM information_schema.role_table_grants WHERE table_name='$t' AND grantee='service_role'")"
  for v in DELETE TRUNCATE REFERENCES TRIGGER; do
    chk "$t: service_role CANNOT $v" "f" "$(q "SELECT has_table_privilege('service_role','public.$t','$v')")"
  done
  chk "$t: RLS enabled" "t" "$(q "SELECT relrowsecurity FROM pg_class WHERE oid='public.$t'::regclass")"
  chk "$t: zero policies" "0" "$(q "SELECT count(*) FROM pg_policies WHERE tablename='$t'")"
done
chk "claim fn: PUBLIC cannot execute" "0" \
  "$(q "SELECT count(*) FROM pg_proc p, unnest(coalesce(p.proacl,ARRAY[]::aclitem[])) a WHERE p.proname='claim_invitation_resume_request' AND a::text LIKE '=%'")"
for r in anon authenticated; do
  chk "claim fn: $r cannot execute" "f" "$(q "SELECT has_function_privilege('$r', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='claim_invitation_resume_request'")"
done
chk "claim fn: service_role CAN execute" "t" "$(q "SELECT has_function_privilege('service_role', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='claim_invitation_resume_request'")"
chk "claim fn: empty search_path" 't' "$(q "SELECT 'search_path=\"\"' = ANY(proconfig) FROM pg_proc WHERE proname='claim_invitation_resume_request'")"
chk "no FK on resume tokens (deletion must not be blocked)" "0" \
  "$(q "SELECT count(*) FROM pg_constraint WHERE conrelid='public.invitation_resume_tokens'::regclass AND contype='f'")"
chk "no column can hold an email/token plaintext" "" \
  "$(q "SELECT string_agg(column_name,',') FROM information_schema.columns WHERE table_name='invitation_resume_tokens' AND column_name ~* 'email|plaintext|secret|password'")"

echo "── 2. token hash constraints ──"
chk "hash must be exactly 32 bytes" "rejected" \
  "$("${PSQL[@]}" -c "INSERT INTO public.invitation_resume_tokens(token_sha256) VALUES ('\\x0011')" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"
"${PSQL[@]}" -c "INSERT INTO public.waitlist(id,email,full_name,status,invited_at) VALUES ('11111111-1111-1111-1111-111111111111','a@x.com','A','invited', now() - interval '10 days');" >/dev/null
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('22222222-2222-2222-2222-222222222222','a@x.com');" >/dev/null
H1='\x'$(printf 'tok-one' | shasum -a 256 | cut -d' ' -f1)
H2='\x'$(printf 'tok-two' | shasum -a 256 | cut -d' ' -f1)
"${PSQL[@]}" -c "INSERT INTO public.invitation_resume_tokens(waitlist_id,auth_user_id,token_sha256) VALUES ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','$H1');" >/dev/null
chk "duplicate hash rejected" "rejected" \
  "$("${PSQL[@]}" -c "INSERT INTO public.invitation_resume_tokens(auth_user_id,token_sha256) VALUES ('22222222-2222-2222-2222-222222222222','$H1')" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"
chk "BLOCKER 2: auth_user_id is NOT NULL" "rejected" \
  "$("${PSQL[@]}" -c "INSERT INTO public.invitation_resume_tokens(waitlist_id,token_sha256) VALUES ('11111111-1111-1111-1111-111111111111','$H2')" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"
chk "BLOCKER 3: a SECOND live token for one invitation is ALLOWED" "ok" \
  "$("${PSQL[@]}" -c "INSERT INTO public.invitation_resume_tokens(waitlist_id,auth_user_id,token_sha256) VALUES ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','$H2')" >/dev/null 2>&1 && echo ok || echo REJECTED)"
chk "the one-live-token index is gone" "0" \
  "$(q "SELECT count(*) FROM pg_indexes WHERE indexname='invitation_resume_tokens_live_uniq'")"

echo "── 3. the atomic claim: eligibility + rate limit in one call ──"
st(){ q "SELECT status FROM public.claim_invitation_resume_request('$1')"; }
chk "valid token → ok"                    "ok"      "$(st "$H1")"
HX='\x'$(printf 'never-issued' | shasum -a 256 | cut -d' ' -f1)
chk "unknown token → invalid (generic)"   "invalid" "$(st "$HX")"
chk "malformed length → invalid"          "invalid" "$(q "SELECT status FROM public.claim_invitation_resume_request('\\x00')")"
chk "second request still ok (NOT consumed)" "ok"   "$(st "$H1")"
chk "third request still ok"              "ok"      "$(st "$H1")"
chk "fourth request → rate_limited"       "rate_limited" "$(st "$H1")"
chk "token still LIVE after rate limiting" "1" \
  "$(q "SELECT count(*) FROM public.invitation_resume_tokens WHERE token_sha256='$H1' AND revoked_at IS NULL AND superseded_at IS NULL")"
"${PSQL[@]}" -c "UPDATE public.invitation_resume_tokens SET window_started_at = now() - interval '2 hours' WHERE token_sha256='$H1';" >/dev/null
chk "usable again after the window rolls"  "ok"     "$(st "$H1")"

echo "── 4. terminal events invalidate ──"
"${PSQL[@]}" -c "UPDATE public.invitation_resume_tokens SET window_started_at = now() - interval '2 hours' WHERE token_sha256='$H1'; INSERT INTO public.profiles(id,email,profile_complete) VALUES ('22222222-2222-2222-2222-222222222222','a@x.com',true);" >/dev/null
chk "profile_complete → completed"        "completed" "$(st "$H1")"
"${PSQL[@]}" -c "UPDATE public.profiles SET profile_complete=false WHERE id='22222222-2222-2222-2222-222222222222'; UPDATE public.invitation_resume_tokens SET window_started_at = now() - interval '2 hours' WHERE token_sha256='$H1'; UPDATE public.waitlist SET status='revoked' WHERE id='11111111-1111-1111-1111-111111111111';" >/dev/null
chk "revoked invitation → revoked"        "revoked"   "$(st "$H1")"
"${PSQL[@]}" -c "UPDATE public.waitlist SET status='invited' WHERE id='11111111-1111-1111-1111-111111111111'; UPDATE public.invitation_resume_tokens SET window_started_at = now() - interval '2 hours', revoked_at = now() WHERE token_sha256='$H1';" >/dev/null
chk "admin rotation (revoked_at) → revoked" "revoked" "$(st "$H1")"
"${PSQL[@]}" -c "UPDATE public.invitation_resume_tokens SET revoked_at=NULL, window_started_at = now() - interval '2 hours' WHERE token_sha256='$H1'; INSERT INTO auth.users(email) VALUES ('a@x.com');" >/dev/null
chk "ambiguous identity → ambiguous"      "ambiguous" "$(st "$H1")"
"${PSQL[@]}" -c "DELETE FROM auth.users WHERE id NOT IN ('22222222-2222-2222-2222-222222222222'); UPDATE public.invitation_resume_tokens SET window_started_at = now() - interval '2 hours' WHERE token_sha256='$H1'; INSERT INTO public.invitation_deliveries(waitlist_id,recipient_email,purpose,status) VALUES (NULL,'a@x.com','first_invite','bounced');" >/dev/null
chk "suppressed address → suppressed"     "suppressed" "$(st "$H1")"
"${PSQL[@]}" -c "DELETE FROM public.invitation_deliveries WHERE status='bounced'; UPDATE public.invitation_resume_tokens SET window_started_at = now() - interval '2 hours' WHERE token_sha256='$H1'; DELETE FROM public.waitlist WHERE id='11111111-1111-1111-1111-111111111111';" >/dev/null
chk "deleted invitation → invalid (no FK blocked the delete)" "invalid" "$(st "$H1")"
chk "the token row SURVIVED the delete (no cascade)" "1" "$(q "SELECT count(*) FROM public.invitation_resume_tokens WHERE token_sha256='$H1'")"

echo "── 5. staged reminder purposes + per-stage dedupe ──"
"${PSQL[@]}" -c "INSERT INTO public.waitlist(id,email,status,invited_at,reminder_enrollment_at) VALUES ('33333333-3333-3333-3333-333333333333','b@x.com','invited', now() - interval '10 days', now() - interval '10 days');" >/dev/null
for p in onboarding_reminder_1 onboarding_reminder_2 onboarding_reminder_3 onboarding_catchup; do
  chk "purpose '$p' accepted" "ok" \
    "$("${PSQL[@]}" -c "INSERT INTO public.invitation_deliveries(waitlist_id,recipient_email,purpose,status) VALUES ('33333333-3333-3333-3333-333333333333','b@x.com','$p','claimed')" >/dev/null 2>&1 && echo ok || echo REJECTED)"
done
chk "repeat claim of the SAME stage rejected (dedupe)" "rejected" \
  "$("${PSQL[@]}" -c "INSERT INTO public.invitation_deliveries(waitlist_id,recipient_email,purpose,status) VALUES ('33333333-3333-3333-3333-333333333333','b@x.com','onboarding_reminder_1','claimed')" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"
chk "three stages + catchup all recorded" "4" \
  "$(q "SELECT count(*) FROM public.invitation_deliveries WHERE waitlist_id='33333333-3333-3333-3333-333333333333'")"
chk "unknown purpose still rejected" "rejected" \
  "$("${PSQL[@]}" -c "INSERT INTO public.invitation_deliveries(waitlist_id,recipient_email,purpose,status) VALUES (NULL,'b@x.com','bogus','claimed')" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"

echo "── 6. prospective enrollment: NO backfill ──"
chk "reminder_enrollment_at column exists" "1" \
  "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='waitlist' AND column_name='reminder_enrollment_at'")"
"${PSQL[@]}" -c "INSERT INTO public.waitlist(email,status,invited_at) VALUES ('historical@x.com','invited', now() - interval '200 days');" >/dev/null
chk "a pre-077 style row stays NULL (never backfilled)" "1" \
  "$(q "SELECT count(*) FROM public.waitlist WHERE email='historical@x.com' AND reminder_enrollment_at IS NULL")"
chk "077 contains no UPDATE of existing rows" "0" \
  "$(grep -cE '^\s*UPDATE public\.waitlist' supabase/migrations/077_onboarding_reminder_stages.sql || true)"

echo "── 7. concurrent stage claims: exactly one wins ──"
"${PSQL[@]}" -c "INSERT INTO public.waitlist(id,email,status,invited_at,reminder_enrollment_at) VALUES ('44444444-4444-4444-4444-444444444444','c@x.com','invited',now()-interval '2 days',now()-interval '2 days');" >/dev/null
for i in 1 2 3 4 5 6; do
  ("$PGBIN/psql" -U postgres -X -q -c "INSERT INTO public.invitation_deliveries(waitlist_id,recipient_email,purpose,status) VALUES ('44444444-4444-4444-4444-444444444444','c@x.com','onboarding_reminder_1','claimed')" >/dev/null 2>&1 || true) &
done
wait
chk "6 concurrent workers produced exactly 1 claim" "1" \
  "$(q "SELECT count(*) FROM public.invitation_deliveries WHERE waitlist_id='44444444-4444-4444-4444-444444444444' AND purpose='onboarding_reminder_1'")"

echo "── 8. no plaintext token is representable ──"
chk "token column is bytea" "bytea" \
  "$(q "SELECT data_type FROM information_schema.columns WHERE table_name='invitation_resume_tokens' AND column_name='token_sha256'")"
chk "no row holds anything but a 32-byte digest" "0" \
  "$(q "SELECT count(*) FROM public.invitation_resume_tokens WHERE octet_length(token_sha256) <> 32")"

echo "── 9. BLOCKER 3: stage 1 stays usable after stages 2 and 3 are issued ──"
W9=99999999-9999-9999-9999-999999999999; U9=88888888-8888-8888-8888-888888888888
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email,last_sign_in_at) VALUES ('$U9','multi@x.com', now()); INSERT INTO public.waitlist(id,email,status,invited_at) VALUES ('$W9','multi@x.com','invited', now()-interval '10 days');" >/dev/null
S1='\x'$(printf 's1' | shasum -a 256 | cut -d' ' -f1)
S2='\x'$(printf 's2' | shasum -a 256 | cut -d' ' -f1)
S3='\x'$(printf 's3' | shasum -a 256 | cut -d' ' -f1)
for h in "$S1" "$S2" "$S3"; do
  "${PSQL[@]}" -c "INSERT INTO public.invitation_resume_tokens(waitlist_id,auth_user_id,token_sha256) VALUES ('$W9','$U9','$h');" >/dev/null
done
chk "three simultaneously live tokens for one invitation" "3" \
  "$(q "SELECT count(*) FROM public.invitation_resume_tokens WHERE waitlist_id='$W9' AND revoked_at IS NULL AND superseded_at IS NULL")"
chk "stage-1 token still works after 2 and 3 were issued" "ok" "$(st "$S1")"
chk "stage-2 token works"                                  "ok" "$(st "$S2")"
chk "stage-3 token works"                                  "ok" "$(st "$S3")"
"${PSQL[@]}" -c "UPDATE public.invitation_resume_tokens SET superseded_at = now() WHERE waitlist_id='$W9';" >/dev/null
chk "admin rotation supersedes ALL of them at once (1)" "revoked" "$(st "$S1")"
chk "admin rotation supersedes ALL of them at once (3)" "revoked" "$(st "$S3")"
"${PSQL[@]}" -c "UPDATE public.invitation_resume_tokens SET superseded_at = NULL, window_started_at = now()-interval '2 hours' WHERE waitlist_id='$W9';" >/dev/null
"${PSQL[@]}" -c "INSERT INTO public.profiles(id,email,profile_complete) VALUES ('$U9','multi@x.com',true);" >/dev/null
chk "completion invalidates EVERY token at once (1)" "completed" "$(st "$S1")"
chk "completion invalidates EVERY token at once (2)" "completed" "$(st "$S2")"

echo "── 10. BLOCKER 2: identity binding rejects a recreated account ──"
"${PSQL[@]}" -c "UPDATE public.profiles SET profile_complete=false WHERE id='$U9'; UPDATE public.invitation_resume_tokens SET window_started_at=now()-interval '2 hours' WHERE waitlist_id='$W9';" >/dev/null
chk "baseline: valid again" "ok" "$(st "$S1")"
# delete and RECREATE at the same address — a different person to the database
"${PSQL[@]}" -c "DELETE FROM public.profiles WHERE id='$U9'; DELETE FROM auth.users WHERE id='$U9'; INSERT INTO auth.users(email,last_sign_in_at) VALUES ('multi@x.com', now()); UPDATE public.invitation_resume_tokens SET window_started_at=now()-interval '2 hours' WHERE waitlist_id='$W9';" >/dev/null
chk "recreated identity → identity_changed (not silently ok)" "identity_changed" "$(st "$S1")"
"${PSQL[@]}" -c "DELETE FROM auth.users WHERE email='multi@x.com'; UPDATE public.invitation_resume_tokens SET window_started_at=now()-interval '2 hours' WHERE waitlist_id='$W9';" >/dev/null
chk "deleted identity → ambiguous"  "ambiguous" "$(st "$S1")"

echo "── 11. BLOCKER 2: waitlist status must be EXACTLY 'invited' ──"
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email,last_sign_in_at) VALUES ('$U9','multi@x.com',now()); UPDATE public.invitation_resume_tokens SET window_started_at=now()-interval '2 hours' WHERE waitlist_id='$W9';" >/dev/null
for stt in pending approved declined revoked joined some_future_status; do
  "${PSQL[@]}" -c "UPDATE public.waitlist SET status='$stt' WHERE id='$W9'; UPDATE public.invitation_resume_tokens SET window_started_at=now()-interval '2 hours' WHERE waitlist_id='$W9';" >/dev/null
  chk "status '$stt' → refused" "revoked" "$(st "$S1")"
done
"${PSQL[@]}" -c "UPDATE public.waitlist SET status='invited' WHERE id='$W9'; UPDATE public.invitation_resume_tokens SET window_started_at=now()-interval '2 hours' WHERE waitlist_id='$W9';" >/dev/null
chk "status 'invited' → ok" "ok" "$(st "$S1")"

echo "── 12. BLOCKER 4: random tokens cannot exhaust the global bucket ──"
"${PSQL[@]}" -c "DELETE FROM public.invitation_resume_rate;" >/dev/null
for i in $(seq 1 60); do q "SELECT status FROM public.claim_invitation_resume_request(pg_catalog.sha256(('junk'||$i)::bytea))" >/dev/null; done
chk "60 random tokens moved the global counter by" "0" \
  "$(q "SELECT coalesce(sum(request_count),0)::text FROM public.invitation_resume_rate")"
"${PSQL[@]}" -c "UPDATE public.invitation_resume_tokens SET window_started_at=now()-interval '2 hours', window_count=0 WHERE waitlist_id='$W9';" >/dev/null
chk "a legitimate holder is unaffected by that flood" "ok" "$(st "$S1")"
chk "and the global counter only moves for valid requests" "1" \
  "$(q "SELECT sum(request_count)::text FROM public.invitation_resume_rate")"
echo "  -- one valid token cannot exhaust the global bucket: per-token stops it first --"
"${PSQL[@]}" -c "DELETE FROM public.invitation_resume_rate; UPDATE public.invitation_resume_tokens SET window_started_at=now(), window_count=0 WHERE token_sha256='$S1';" >/dev/null
for i in 1 2 3 4 5 6 7 8 9 10; do q "SELECT status FROM public.claim_invitation_resume_request('$S1')" >/dev/null; done
chk "10 attempts on ONE token → global moved only 3" "3" \
  "$(q "SELECT sum(request_count)::text FROM public.invitation_resume_rate")"
chk "global ceiling (30) is far from reached by one holder" "t" \
  "$(q "SELECT (sum(request_count) < 30) FROM public.invitation_resume_rate")"
echo "  -- global exhaustion must NOT consume a holder's own allowance --"
"${PSQL[@]}" -c "DELETE FROM public.invitation_resume_rate; INSERT INTO public.invitation_resume_rate(minute_bucket,request_count) VALUES (date_trunc('minute',now()), 500); UPDATE public.invitation_resume_tokens SET window_started_at=now(), window_count=0 WHERE token_sha256='$S1';" >/dev/null
chk "global full → rate_limited" "rate_limited" "$(st "$S1")"
chk "the holder's per-token allowance was NOT consumed" "0" \
  "$(q "SELECT window_count FROM public.invitation_resume_tokens WHERE token_sha256='$S1'")"

echo "── 13. BLOCKER 5: failed stages are retryable, others are not ──"
W13=aaaaaaaa-0000-0000-0000-00000000aaaa
"${PSQL[@]}" -c "INSERT INTO public.waitlist(id,email,status,invited_at,reminder_enrollment_at) VALUES ('$W13','r@x.com','invited',now()-interval '9 days',now()-interval '9 days'); INSERT INTO public.invitation_deliveries(waitlist_id,recipient_email,purpose,status) VALUES ('$W13','r@x.com','onboarding_reminder_1','failed');" >/dev/null
chk "a FAILED stage may be re-claimed" "ok" \
  "$("${PSQL[@]}" -c "INSERT INTO public.invitation_deliveries(waitlist_id,recipient_email,purpose,status) VALUES ('$W13','r@x.com','onboarding_reminder_1','claimed')" >/dev/null 2>&1 && echo ok || echo REJECTED)"
for s13 in accepted delivered deferred bounced blocked complained; do
  "${PSQL[@]}" -c "UPDATE public.invitation_deliveries SET status='$s13' WHERE waitlist_id='$W13' AND status='claimed';" >/dev/null
  chk "status '$s13' CONSUMES the stage" "rejected" \
    "$("${PSQL[@]}" -c "INSERT INTO public.invitation_deliveries(waitlist_id,recipient_email,purpose,status) VALUES ('$W13','r@x.com','onboarding_reminder_1','claimed')" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"
  "${PSQL[@]}" -c "UPDATE public.invitation_deliveries SET status='claimed' WHERE waitlist_id='$W13' AND status='$s13';" >/dev/null
done
echo "  -- concurrency still yields exactly one provider call on a retry --"
"${PSQL[@]}" -c "UPDATE public.invitation_deliveries SET status='failed' WHERE waitlist_id='$W13';" >/dev/null
for i in 1 2 3 4 5 6; do
  ("$PGBIN/psql" -U postgres -X -q -c "INSERT INTO public.invitation_deliveries(waitlist_id,recipient_email,purpose,status) VALUES ('$W13','r@x.com','onboarding_reminder_1','claimed')" >/dev/null 2>&1 || true) &
done
wait
chk "6 concurrent retries produced exactly 1 non-failed claim" "1" \
  "$(q "SELECT count(*) FROM public.invitation_deliveries WHERE waitlist_id='$W13' AND purpose='onboarding_reminder_1' AND status <> 'failed'")"

echo "── 14. BLOCKER 6: the authoritative identity resolver ──"
chk "resolver exists" "1" "$(q "SELECT count(*) FROM pg_proc WHERE proname='lookup_auth_identity'")"
chk "SECURITY DEFINER" "t" "$(q "SELECT prosecdef FROM pg_proc WHERE proname='lookup_auth_identity'")"
chk "empty search_path" "t" "$(q "SELECT 'search_path=\"\"' = ANY(proconfig) FROM pg_proc WHERE proname='lookup_auth_identity'")"
chk "PUBLIC cannot execute" "0" \
  "$(q "SELECT count(*) FROM pg_proc p, unnest(coalesce(p.proacl,ARRAY[]::aclitem[])) a WHERE p.proname='lookup_auth_identity' AND a::text LIKE '=%'")"
for r in anon authenticated; do
  chk "$r cannot execute the resolver" "f" "$(q "SELECT has_function_privilege('$r', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='lookup_auth_identity'")"
done
chk "service_role CAN execute the resolver" "t" "$(q "SELECT has_function_privilege('service_role', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='lookup_auth_identity'")"
chk "emits no email column" "" \
  "$(q "SELECT string_agg(p.proargnames[i],',') FROM pg_proc p, generate_subscripts(p.proargnames,1) i WHERE p.proname='lookup_auth_identity' AND p.proargnames[i] ~* 'email' AND i > 1")"
chk "resolves beyond a 200-row page (300 identities)" "1" \
  "$(q "DO \$\$ BEGIN FOR i IN 1..300 LOOP INSERT INTO auth.users(email) VALUES ('bulk'||i||'@x.com'); END LOOP; END \$\$; SELECT identity_count FROM public.lookup_auth_identity('bulk300@x.com')" 2>/dev/null || q "SELECT identity_count FROM public.lookup_auth_identity('bulk300@x.com')")"
chk "unknown address → count 0, uuid NULL" "0|" \
  "$(q "SELECT identity_count || '|' || coalesce(auth_user_id::text,'') FROM public.lookup_auth_identity('nobody@x.com')")"
chk "ambiguous address → uuid NULL despite count 2" "2|" \
  "$("${PSQL[@]}" -c "INSERT INTO auth.users(email) VALUES ('dup@x.com'),('dup@x.com')" >/dev/null; q "SELECT identity_count || '|' || coalesce(auth_user_id::text,'') FROM public.lookup_auth_identity('dup@x.com')")"
chk "case/whitespace normalized" "1" \
  "$(q "SELECT identity_count FROM public.lookup_auth_identity('  BULK1@X.COM ')")"

echo "── 15. MIGRATION 079: incomplete profiles are undiscoverable ──"
VIEWER=cccccccc-0000-0000-0000-00000000cccc; TARGET=dddddddd-0000-0000-0000-00000000dddd
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$VIEWER','v@x.com'),('$TARGET','t@x.com');
INSERT INTO public.profiles(id,email,profile_complete) VALUES ('$VIEWER','v@x.com',true),('$TARGET','t@x.com',false);
INSERT INTO public.matches(user_a_id,user_b_id,status) VALUES ('$VIEWER','$TARGET','active');" >/dev/null
disc(){ q "SET LOCAL test.uid='$1'; SELECT public.can_discover_profile('$2')"; }
chk "HISTORICAL match + INCOMPLETE target → NOT discoverable" "f" "$(disc $VIEWER $TARGET)"
"${PSQL[@]}" -c "UPDATE public.profiles SET profile_complete=true WHERE id='$TARGET';" >/dev/null
chk "same match, target now COMPLETE → discoverable" "t" "$(disc $VIEWER $TARGET)"
"${PSQL[@]}" -c "UPDATE public.profiles SET is_test_account=true WHERE id='$TARGET';" >/dev/null
chk "test account → NOT discoverable" "f" "$(disc $VIEWER $TARGET)"
"${PSQL[@]}" -c "UPDATE public.profiles SET is_test_account=false, profile_complete=false WHERE id='$VIEWER';" >/dev/null
chk "SELF is discoverable even while INCOMPLETE (self branch preserved)" "t" "$(disc $VIEWER $VIEWER)"
"${PSQL[@]}" -c "UPDATE public.profiles SET profile_complete=true WHERE id='$VIEWER'; INSERT INTO public.blocked_users(user_id,blocked_user_id) VALUES ('$VIEWER','$TARGET');" >/dev/null
chk "blocking still wins" "f" "$(disc $VIEWER $TARGET)"

echo "── 16. lookup_waitlist_identity: one normalization contract ──"
chk "resolver exists" "1" "$(q "SELECT count(*) FROM pg_proc WHERE proname='lookup_waitlist_identity'")"
chk "SECURITY DEFINER, empty search_path" "t" \
  "$(q "SELECT prosecdef AND 'search_path=\"\"' = ANY(proconfig) FROM pg_proc WHERE proname='lookup_waitlist_identity'")"
chk "PUBLIC cannot execute" "0" \
  "$(q "SELECT count(*) FROM pg_proc p, unnest(coalesce(p.proacl,ARRAY[]::aclitem[])) a WHERE p.proname='lookup_waitlist_identity' AND a::text LIKE '=%'")"
for r in anon authenticated; do
  chk "$r cannot execute" "f" "$(q "SELECT has_function_privilege('$r', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='lookup_waitlist_identity'")"
done
chk "service_role CAN execute" "t" "$(q "SELECT has_function_privilege('service_role', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='lookup_waitlist_identity'")"
"${PSQL[@]}" -c "INSERT INTO public.waitlist(email,status,invited_at) VALUES ('  Norm@Case.COM ','invited', now()-interval '5 days');" >/dev/null
chk "case + whitespace normalized (not ILIKE)" "1|1" \
  "$(q "SELECT total_rows || '|' || invited_count FROM public.lookup_waitlist_identity('norm@case.com')")"
"${PSQL[@]}" -c "INSERT INTO public.waitlist(email,status) VALUES ('wild_card@x.com','invited'),('wildXcard@x.com','revoked');" >/dev/null
chk "underscore is NOT a wildcard (ILIKE would match both)" "1" \
  "$(q "SELECT total_rows FROM public.lookup_waitlist_identity('wild_card@x.com')")"
"${PSQL[@]}" -c "INSERT INTO public.waitlist(email,status) VALUES ('conflict@x.com','invited'),('conflict@x.com','revoked');" >/dev/null
chk "conflicting rows are visible to the caller" "2|1|true" \
  "$(q "SELECT total_rows || '|' || invited_count || '|' || has_revoked FROM public.lookup_waitlist_identity('conflict@x.com')")"
"${PSQL[@]}" -c "INSERT INTO public.waitlist(email,status) VALUES ('twoinv@x.com','invited'),('twoinv@x.com','invited');" >/dev/null
chk "two invited rows → invited_id is NULL" "2|" \
  "$(q "SELECT invited_count || '|' || coalesce(invited_id::text,'') FROM public.lookup_waitlist_identity('twoinv@x.com')")"
chk "unknown address → all zero" "0|0|" \
  "$(q "SELECT total_rows || '|' || invited_count || '|' || coalesce(invited_id::text,'') FROM public.lookup_waitlist_identity('nobody@x.com')")"
chk "emits no email argument or column" "" \
  "$(q "SELECT string_agg(p.proargnames[i],',') FROM pg_proc p, generate_subscripts(p.proargnames,1) i WHERE p.proname='lookup_waitlist_identity' AND p.proargnames[i] ~* 'email' AND i > 1")"

# Section 12 deliberately saturated the global bucket to prove a flood cannot burn a holder's own
# allowance. Clear it here or every later claim would be throttled by that fixture rather than by
# the property under test.
"${PSQL[@]}" -c "DELETE FROM public.invitation_resume_rate;" >/dev/null
echo "── 17. rotation operations: prepare / accept / finalize, resumable ──"
WR=bbbbbbbb-0000-0000-0000-00000000bbbb; UR=cccccccc-1111-1111-1111-11111111cccc
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email,last_sign_in_at) VALUES ('$UR','rot@x.com',now()); INSERT INTO public.waitlist(id,email,status,invited_at) VALUES ('$WR','rot@x.com','invited',now()-interval '9 days');" >/dev/null
R1='\x'$(printf 'r1' | shasum -a 256 | cut -d' ' -f1)
R2='\x'$(printf 'r2' | shasum -a 256 | cut -d' ' -f1)
for h in "$R1" "$R2"; do
  "${PSQL[@]}" -c "INSERT INTO public.invitation_resume_tokens(waitlist_id,auth_user_id,token_sha256) VALUES ('$WR','$UR','$h');" >/dev/null
done
NEWTOK='\x'$(printf 'replacement' | shasum -a 256 | cut -d' ' -f1)
OP=$(q "SELECT out_operation_id FROM public.begin_resume_rotation('$WR','$UR','$NEWTOK')")
chk "begin created an operation" "t" "$([ -n "$OP" ] && echo t || echo f)"
chk "state is prepared" "prepared" "$(q "SELECT state FROM public.invitation_rotation_operations WHERE id='$OP'")"
chk "PREPARE retired nothing — all three live" "3" \
  "$(q "SELECT count(*) FROM public.invitation_resume_tokens WHERE waitlist_id='$WR' AND revoked_at IS NULL AND superseded_at IS NULL")"
chk "a concurrent begin CONVERGES (created=false)" "f" \
  "$(q "SELECT out_created FROM public.begin_resume_rotation('$WR','$UR', pg_catalog.sha256('other'::bytea))")"
chk "and mints no second operation" "1" \
  "$(q "SELECT count(*) FROM public.invitation_rotation_operations WHERE waitlist_id='$WR'")"
chk "finalizing while merely 'prepared' retires NOTHING" "prepared|0" \
  "$(q "SELECT out_state || '|' || out_retired FROM public.finalize_resume_rotation('$OP')")"
chk "old links still live after that refusal" "3" \
  "$(q "SELECT count(*) FROM public.invitation_resume_tokens WHERE waitlist_id='$WR' AND revoked_at IS NULL AND superseded_at IS NULL")"
"${PSQL[@]}" -c "SELECT public.record_resume_rotation_outcome('$OP','accepted_pending_finalize',NULL,NULL);" >/dev/null
chk "acceptance recorded before finalization" "accepted_pending_finalize" \
  "$(q "SELECT state FROM public.invitation_rotation_operations WHERE id='$OP'")"
chk "FINALIZE retires the two older tokens" "finalized|2" \
  "$(q "SELECT out_state || '|' || out_retired FROM public.finalize_resume_rotation('$OP')")"
"${PSQL[@]}" -c "DELETE FROM public.invitation_resume_rate; UPDATE public.invitation_resume_tokens SET window_started_at=now()-interval '2 hours' WHERE waitlist_id='$WR';" >/dev/null
chk "old token 1 refused" "revoked" "$(st "$R1")"
chk "old token 2 refused" "revoked" "$(st "$R2")"
chk "the replacement works" "ok" "$(st "$NEWTOK")"
chk "FINALIZE is idempotent on replay (no second email needed)" "finalized|0" \
  "$(q "SELECT out_state || '|' || out_retired FROM public.finalize_resume_rotation('$OP')")"
chk "a finalized operation frees the invitation for a future rotation" "t" \
  "$(q "SELECT out_created FROM public.begin_resume_rotation('$WR','$UR', pg_catalog.sha256('future'::bytea))")"

echo "  -- BLOCKER D: accepted-but-not-finalized is RESUMABLE without resending --"
WD=ffffffff-0000-0000-0000-00000000ffff; UD=99999999-2222-2222-2222-22222222dddd
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UD','res@x.com'); INSERT INTO public.waitlist(id,email,status,invited_at) VALUES ('$WD','res@x.com','invited',now()-interval '3 days');
INSERT INTO public.invitation_resume_tokens(waitlist_id,auth_user_id,token_sha256) VALUES ('$WD','$UD', pg_catalog.sha256('old-d'::bytea));" >/dev/null
OPD=$(q "SELECT out_operation_id FROM public.begin_resume_rotation('$WD','$UD', pg_catalog.sha256('new-d'::bytea))")
"${PSQL[@]}" -c "SELECT public.record_resume_rotation_outcome('$OPD','accepted_pending_finalize',NULL,NULL);" >/dev/null
# simulate the crash: finalization never ran. A retry must CONVERGE on this operation, not start one.
chk "a retry converges on the accepted operation" "false|accepted_pending_finalize" \
  "$(q "SELECT out_created || '|' || out_state FROM public.begin_resume_rotation('$WD','$UD', pg_catalog.sha256('retry-d'::bytea))")"
chk "it knows which replacement to keep" "1" \
  "$(q "SELECT count(*) FROM public.invitation_rotation_operations WHERE id='$OPD' AND replacement_token_id IS NOT NULL")"
chk "resumed finalization completes it" "finalized|1" \
  "$(q "SELECT out_state || '|' || out_retired FROM public.finalize_resume_rotation('$OPD')")"

echo "  -- uncertain is NOT resendable until it resolves --"
WU=11111111-2222-3333-4444-555555555555; UU=22222222-3333-4444-5555-666666666666
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UU','unc@x.com'); INSERT INTO public.waitlist(id,email,status,invited_at) VALUES ('$WU','unc@x.com','invited',now());" >/dev/null
OPU=$(q "SELECT out_operation_id FROM public.begin_resume_rotation('$WU','$UU', pg_catalog.sha256('unc'::bytea))")
"${PSQL[@]}" -c "SELECT public.record_resume_rotation_outcome('$OPU','uncertain',NULL,'provider_timeout');" >/dev/null
chk "an uncertain operation blocks a new attempt" "false|uncertain" \
  "$(q "SELECT out_created || '|' || out_state FROM public.begin_resume_rotation('$WU','$UU', pg_catalog.sha256('unc2'::bytea))")"
chk "and finalization refuses while uncertain" "uncertain|0" \
  "$(q "SELECT out_state || '|' || out_retired FROM public.finalize_resume_rotation('$OPU')")"

echo "  -- a definite failure is retryable --"
"${PSQL[@]}" -c "SELECT public.record_resume_rotation_outcome('$OPU','failed',NULL,'provider_error');" >/dev/null
chk "a failed operation frees the invitation" "t" \
  "$(q "SELECT out_created FROM public.begin_resume_rotation('$WU','$UU', pg_catalog.sha256('retry-u'::bytea))")"

echo "  -- concurrent begins yield exactly ONE operation --"
WC=aabbccdd-0000-1111-2222-333344445555; UC=bbccddee-0000-1111-2222-333344445555
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UC','conc@x.com'); INSERT INTO public.waitlist(id,email,status,invited_at) VALUES ('$WC','conc@x.com','invited',now());" >/dev/null
for i in 1 2 3 4 5 6; do
  ("$PGBIN/psql" -U postgres -X -q -c "SELECT public.begin_resume_rotation('$WC','$UC', pg_catalog.sha256(('c'||$i)::bytea))" >/dev/null 2>&1 || true) &
done
wait
chk "6 concurrent begins produced exactly 1 operation" "1" \
  "$(q "SELECT count(*) FROM public.invitation_rotation_operations WHERE waitlist_id='$WC'")"
chk "and exactly 1 replacement token" "1" \
  "$(q "SELECT count(*) FROM public.invitation_resume_tokens WHERE waitlist_id='$WC'")"

echo "  -- BLOCKER C: no prior delivery purpose can block rotation --"
for pri in first_invite access_resend onboarding_reminder_1 onboarding_catchup; do
  "${PSQL[@]}" -c "INSERT INTO public.invitation_deliveries(waitlist_id,recipient_email,purpose,status) VALUES ('$WC','conc@x.com','$pri','accepted');" >/dev/null
done
chk "rotation delivery row inserts despite 4 accepted prior purposes" "ok" \
  "$("${PSQL[@]}" -c "INSERT INTO public.invitation_deliveries(waitlist_id,auth_user_id,recipient_email,purpose,status) VALUES (NULL,'$UC','conc@x.com','resume_rotation','claimed')" >/dev/null 2>&1 && echo ok || echo BLOCKED)"
chk "a second resume_access is NOT blocked by an accepted one" "ok" \
  "$("${PSQL[@]}" -c "INSERT INTO public.invitation_deliveries(waitlist_id,auth_user_id,recipient_email,purpose,status) VALUES (NULL,'$UC','conc@x.com','resume_access','accepted'); INSERT INTO public.invitation_deliveries(waitlist_id,auth_user_id,recipient_email,purpose,status) VALUES (NULL,'$UC','conc@x.com','resume_access','claimed')" >/dev/null 2>&1 && echo ok || echo BLOCKED)"

echo "  -- rotation-operations privileges under inherited defaults --"
for r in anon authenticated; do
  chk "invitation_rotation_operations: $r has NO privilege" "" \
    "$(q "SELECT string_agg(privilege_type,',') FROM information_schema.role_table_grants WHERE table_name='invitation_rotation_operations' AND grantee='$r'")"
done
chk "service_role = INSERT,SELECT,UPDATE" "INSERT,SELECT,UPDATE" \
  "$(q "SELECT string_agg(privilege_type,',' ORDER BY privilege_type) FROM information_schema.role_table_grants WHERE table_name='invitation_rotation_operations' AND grantee='service_role'")"
chk "RLS enabled, zero policies" "true|0" \
  "$(q "SELECT relrowsecurity || '|' || (SELECT count(*) FROM pg_policies WHERE tablename='invitation_rotation_operations') FROM pg_class WHERE oid='public.invitation_rotation_operations'::regclass")"
chk "no FK on the operations table" "0" \
  "$(q "SELECT count(*) FROM pg_constraint WHERE conrelid='public.invitation_rotation_operations'::regclass AND contype='f'")"
chk "no email or plaintext column" "" \
  "$(q "SELECT string_agg(column_name,',') FROM information_schema.columns WHERE table_name='invitation_rotation_operations' AND column_name ~* 'email|plaintext|secret|token_value'")"

"${PSQL[@]}" -c "DELETE FROM public.invitation_resume_rate;" >/dev/null
echo "── 18. initial-invite token survives its authentication link ──"
# The resume token is independent of the Supabase auth link: nothing about the auth link's expiry
# touches the token row, and later reminder tokens do not retire it.
WI=dddddddd-1111-1111-1111-11111111dddd; UI=eeeeeeee-1111-1111-1111-11111111eeee
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UI','init@x.com'); INSERT INTO public.waitlist(id,email,status,invited_at) VALUES ('$WI','init@x.com','invited',now()-interval '20 days');" >/dev/null
FIRST='\x'$(printf 'first-invite' | shasum -a 256 | cut -d' ' -f1)
"${PSQL[@]}" -c "INSERT INTO public.invitation_resume_tokens(waitlist_id,auth_user_id,token_sha256) VALUES ('$WI','$UI','$FIRST');" >/dev/null
chk "initial-invite resume token works" "ok" "$(st "$FIRST")"
for n in 1 2 3; do
  "${PSQL[@]}" -c "INSERT INTO public.invitation_resume_tokens(waitlist_id,auth_user_id,token_sha256) VALUES ('$WI','$UI', pg_catalog.sha256('later$n'::bytea));" >/dev/null
done
"${PSQL[@]}" -c "UPDATE public.invitation_resume_tokens SET window_started_at=now()-interval '2 hours' WHERE waitlist_id='$WI';" >/dev/null
"${PSQL[@]}" -c "DELETE FROM public.invitation_resume_rate;" >/dev/null
chk "still works after three later reminder tokens" "ok" "$(st "$FIRST")"
chk "four live tokens coexist" "4" \
  "$(q "SELECT count(*) FROM public.invitation_resume_tokens WHERE waitlist_id='$WI' AND revoked_at IS NULL AND superseded_at IS NULL")"
chk "every token is bound to an auth user (NOT NULL)" "0" \
  "$(q "SELECT count(*) FROM public.invitation_resume_tokens WHERE auth_user_id IS NULL")"
"${PSQL[@]}" -c "INSERT INTO public.profiles(id,email,profile_complete) VALUES ('$UI','init@x.com',true); UPDATE public.invitation_resume_tokens SET window_started_at=now()-interval '2 hours' WHERE waitlist_id='$WI';" >/dev/null
chk "completion terminates the initial link too" "completed" "$(st "$FIRST")"

echo "── 19. NEGATIVE CONTROLS: the atomic resume-access claim ──"
UA=aaaa1111-2222-3333-4444-555566667777
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UA','claim@x.com');" >/dev/null
cl(){ q "SELECT out_state FROM public.claim_resume_access_attempt('$UA','claim@x.com')"; }
clid(){ q "SELECT out_delivery_id FROM public.claim_resume_access_attempt('$UA','claim@x.com')"; }

chk "first claim → created" "created" "$(cl)"
chk "an immediate second claim → in_flight (pre-dispatch lease)" "in_flight" "$(cl)"
chk "exactly one delivery row exists" "1" \
  "$(q "SELECT count(*) FROM public.invitation_deliveries WHERE auth_user_id='$UA' AND purpose='resume_access'")"

echo "  -- TWO REAL CONCURRENT SESSIONS: exactly one claim --"
UB=bbbb1111-2222-3333-4444-555566667777
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UB','race@x.com');" >/dev/null
# Both sessions take the advisory lock inside an explicit transaction and sleep, so their critical
# sections genuinely overlap. Without the lock both would insert.
for i in 1 2 3 4 5 6 7 8; do
  ("$PGBIN/psql" -U postgres -X -q -c "BEGIN; SELECT public.claim_resume_access_attempt('$UB','race@x.com'); SELECT pg_sleep(0.15); COMMIT;" >/dev/null 2>&1 || true) &
done
wait
chk "8 concurrent sessions produced exactly 1 claim" "1" \
  "$(q "SELECT count(*) FROM public.invitation_deliveries WHERE auth_user_id='$UB' AND purpose='resume_access'")"
chk "and it is a live pre-dispatch claim" "claimed|pending" \
  "$(q "SELECT status || '|' || dispatch_state FROM public.invitation_deliveries WHERE auth_user_id='$UB' AND purpose='resume_access'")"

echo "  -- UNCERTAIN never becomes retryable, no matter how much time passes --"
UC2=cccc1111-2222-3333-4444-555566667777
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UC2','unc2@x.com');
INSERT INTO public.invitation_deliveries(waitlist_id,auth_user_id,recipient_email,purpose,status,dispatch_state,error_class,attempted_at)
VALUES (NULL,'$UC2','unc2@x.com','resume_access','claimed','uncertain','provider_timeout', now() - interval '61 seconds');" >/dev/null
chk "uncertain + 61s → uncertain_review (NOT created)" "uncertain_review" \
  "$(q "SELECT out_state FROM public.claim_resume_access_attempt('$UC2','unc2@x.com')")"
"${PSQL[@]}" -c "UPDATE public.invitation_deliveries SET attempted_at = now() - interval '30 days' WHERE auth_user_id='$UC2';" >/dev/null
chk "uncertain + 30 DAYS → still uncertain_review" "uncertain_review" \
  "$(q "SELECT out_state FROM public.claim_resume_access_attempt('$UC2','unc2@x.com')")"
chk "no additional delivery row was created" "1" \
  "$(q "SELECT count(*) FROM public.invitation_deliveries WHERE auth_user_id='$UC2' AND purpose='resume_access'")"
"${PSQL[@]}" -c "UPDATE public.invitation_deliveries SET status='delivered', dispatch_state='dispatched', error_class=NULL WHERE auth_user_id='$UC2';" >/dev/null
chk "webhook evidence resolves it (delivered, past debounce) → created" "created" \
  "$(q "SELECT out_state FROM public.claim_resume_access_attempt('$UC2','unc2@x.com')")"

echo "  -- a DEFINITE failure is retryable --"
UD2=dddd1111-2222-3333-4444-555566667777
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UD2','fail2@x.com');
INSERT INTO public.invitation_deliveries(waitlist_id,auth_user_id,recipient_email,purpose,status,dispatch_state,error_class)
VALUES (NULL,'$UD2','fail2@x.com','resume_access','failed','dispatched','provider_error');" >/dev/null
chk "failed → created (retryable)" "created" \
  "$(q "SELECT out_state FROM public.claim_resume_access_attempt('$UD2','fail2@x.com')")"

echo "  -- accepted: debounced now, allowed after the window --"
UE=eeee1111-2222-3333-4444-555566667777
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UE','acc@x.com');
INSERT INTO public.invitation_deliveries(waitlist_id,auth_user_id,recipient_email,purpose,status,dispatch_state,attempted_at)
VALUES (NULL,'$UE','acc@x.com','resume_access','accepted','dispatched', now());" >/dev/null
chk "accepted + immediate second press → debounced" "debounced" \
  "$(q "SELECT out_state FROM public.claim_resume_access_attempt('$UE','acc@x.com')")"
"${PSQL[@]}" -c "UPDATE public.invitation_deliveries SET attempted_at = now() - interval '10 minutes' WHERE auth_user_id='$UE';" >/dev/null
chk "accepted + past the debounce window → created" "created" \
  "$(q "SELECT out_state FROM public.claim_resume_access_attempt('$UE','acc@x.com')")"

echo "  -- a stale PRE-DISPATCH claim is retired safely, not a permanent lockout --"
UF=ffff1111-2222-3333-4444-555566667777
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UF','stale@x.com');
INSERT INTO public.invitation_deliveries(waitlist_id,auth_user_id,recipient_email,purpose,status,dispatch_state,attempted_at)
VALUES (NULL,'$UF','stale@x.com','resume_access','claimed','pending', now() - interval '2 hours');" >/dev/null
chk "stale pre-dispatch claim → created" "created" \
  "$(q "SELECT out_state FROM public.claim_resume_access_attempt('$UF','stale@x.com')")"
chk "the stale row was retired with a closed-vocabulary class" "failed|stale_pre_dispatch" \
  "$(q "SELECT status || '|' || error_class FROM public.invitation_deliveries WHERE auth_user_id='$UF' AND attempted_at < now() - interval '1 hour'")"

echo "  -- claim function privileges --"
chk "SECURITY DEFINER, empty search_path" "t" \
  "$(q "SELECT prosecdef AND 'search_path=\"\"' = ANY(proconfig) FROM pg_proc WHERE proname='claim_resume_access_attempt'")"
chk "PUBLIC cannot execute" "0" \
  "$(q "SELECT count(*) FROM pg_proc p, unnest(coalesce(p.proacl,ARRAY[]::aclitem[])) a WHERE p.proname='claim_resume_access_attempt' AND a::text LIKE '=%'")"
for r in anon authenticated; do
  chk "$r cannot execute the claim" "f" "$(q "SELECT has_function_privilege('$r', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='claim_resume_access_attempt'")"
done
chk "service_role CAN execute the claim" "t" "$(q "SELECT has_function_privilege('service_role', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='claim_resume_access_attempt'")"
chk "dispatch_state vocabulary is closed" "rejected" \
  "$("${PSQL[@]}" -c "INSERT INTO public.invitation_deliveries(auth_user_id,recipient_email,purpose,status,dispatch_state) VALUES ('$UF','x@x.com','resume_access','claimed','provider said something')" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"

echo "  -- an invalid/unknown token creates NO delivery row --"
BEFORE_ROWS=$(q "SELECT count(*) FROM public.invitation_deliveries")
for i in $(seq 1 20); do q "SELECT status FROM public.claim_invitation_resume_request(pg_catalog.sha256(('bogus'||$i)::bytea))" >/dev/null; done
chk "20 invalid resume claims created 0 delivery rows" "$BEFORE_ROWS" "$(q "SELECT count(*) FROM public.invitation_deliveries")"

echo "── 20. CRASH WINDOW: dispatching is never mistaken for never-attempted ──"
UG=1a2b3c4d-0000-0000-0000-00000000aaaa
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UG','crash@x.com');" >/dev/null
mk_claim(){ q "SELECT out_delivery_id FROM public.claim_resume_access_attempt('$1','$2')"; }
cls(){ q "SELECT out_state FROM public.claim_resume_access_attempt('$1','$2')"; }

D1=$(mk_claim "$UG" 'crash@x.com')
chk "the claim starts pending" "claimed|pending" \
  "$(q "SELECT status || '|' || dispatch_state FROM public.invitation_deliveries WHERE id='$D1'")"
chk "the pre-provider marker transitions exactly one row" "t" \
  "$(q "SELECT public.begin_resume_dispatch('$D1')")"
chk "the row now says dispatching" "claimed|dispatching" \
  "$(q "SELECT status || '|' || dispatch_state FROM public.invitation_deliveries WHERE id='$D1'")"
chk "a SECOND marker attempt on the same claim is refused" "f" \
  "$(q "SELECT public.begin_resume_dispatch('$D1')")"

echo "  -- CRASH IMMEDIATELY AFTER the marker, before/during the provider call --"
"${PSQL[@]}" -c "UPDATE public.invitation_deliveries SET attempted_at = now() - interval '2 hours' WHERE id='$D1';" >/dev/null
chk "aged 2h past the lease → still uncertain_review, NOT created" "uncertain_review" "$(cls "$UG" 'crash@x.com')"
chk "no second claim row was created" "1" \
  "$(q "SELECT count(*) FROM public.invitation_deliveries WHERE auth_user_id='$UG' AND purpose='resume_access'")"
chk "the dispatching row was NOT retired as stale_pre_dispatch" "0" \
  "$(q "SELECT count(*) FROM public.invitation_deliveries WHERE id='$D1' AND error_class='stale_pre_dispatch'")"
"${PSQL[@]}" -c "UPDATE public.invitation_deliveries SET attempted_at = now() - interval '30 days' WHERE id='$D1';" >/dev/null
chk "aged 30 DAYS → still uncertain_review" "uncertain_review" "$(cls "$UG" 'crash@x.com')"

echo "  -- PROVIDER ACCEPTED then crash before the accepted update: still non-retryable --"
# The row is exactly as a crash would leave it: dispatching, no provider_message_id.
chk "state is still dispatching" "dispatching" \
  "$(q "SELECT dispatch_state FROM public.invitation_deliveries WHERE id='$D1'")"
chk "and a retry sends nothing" "uncertain_review" "$(cls "$UG" 'crash@x.com')"
"${PSQL[@]}" -c "UPDATE public.invitation_deliveries SET status='delivered', dispatch_state='dispatched', attempted_at=now()-interval '1 day' WHERE id='$D1';" >/dev/null
chk "webhook evidence finally resolves it → created" "created" "$(cls "$UG" 'crash@x.com')"

echo "  -- LINK GENERATION failure BEFORE the marker is safely retryable --"
UH=1a2b3c4d-0000-0000-0000-00000000bbbb
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UH','linkfail@x.com');
INSERT INTO public.invitation_deliveries(waitlist_id,auth_user_id,recipient_email,purpose,status,dispatch_state,error_class)
VALUES (NULL,'$UH','linkfail@x.com','resume_access','failed','pending','link_generation_failed');" >/dev/null
chk "pre-marker failure → created (retryable)" "created" "$(cls "$UH" 'linkfail@x.com')"

echo "  -- a DEFINITE provider refusal remains retryable --"
UI2=1a2b3c4d-0000-0000-0000-00000000cccc
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UI2','refused@x.com');
INSERT INTO public.invitation_deliveries(waitlist_id,auth_user_id,recipient_email,purpose,status,dispatch_state,error_class)
VALUES (NULL,'$UI2','refused@x.com','resume_access','failed','dispatched','provider_error');" >/dev/null
chk "failed + dispatched → created (retryable)" "created" "$(cls "$UI2" 'refused@x.com')"

echo "  -- the marker refuses a claim that is not pre-dispatch --"
chk "cannot mark a FAILED row as dispatching" "f" \
  "$(q "SELECT public.begin_resume_dispatch((SELECT id FROM public.invitation_deliveries WHERE auth_user_id='$UI2' LIMIT 1))")"
chk "cannot mark an unknown id" "f" "$(q "SELECT public.begin_resume_dispatch(gen_random_uuid())")"
chk "cannot mark NULL" "f" "$(q "SELECT public.begin_resume_dispatch(NULL)")"

echo "  -- concurrent markers on one claim: exactly one wins --"
UJ=1a2b3c4d-0000-0000-0000-00000000dddd
"${PSQL[@]}" -c "INSERT INTO auth.users(id,email) VALUES ('$UJ','conc2@x.com');" >/dev/null
DJ=$(mk_claim "$UJ" 'conc2@x.com')
OUT=$(mktemp)
for i in 1 2 3 4 5 6; do
  ("$PGBIN/psql" -U postgres -X -tA -c "SELECT public.begin_resume_dispatch('$DJ')" >> "$OUT" 2>/dev/null || true) &
done
wait
chk "6 concurrent markers → exactly 1 true" "1" "$(grep -c '^t$' "$OUT" || true)"
rm -f "$OUT"

echo "  -- marker function privileges --"
chk "SECURITY DEFINER, empty search_path" "t" \
  "$(q "SELECT prosecdef AND 'search_path=\"\"' = ANY(proconfig) FROM pg_proc WHERE proname='begin_resume_dispatch'")"
chk "PUBLIC cannot execute" "0" \
  "$(q "SELECT count(*) FROM pg_proc p, unnest(coalesce(p.proacl,ARRAY[]::aclitem[])) a WHERE p.proname='begin_resume_dispatch' AND a::text LIKE '=%'")"
for r in anon authenticated; do
  chk "$r cannot execute the marker" "f" "$(q "SELECT has_function_privilege('$r', p.oid,'EXECUTE') FROM pg_proc p WHERE p.proname='begin_resume_dispatch'")"
done
chk "'dispatching' is in the closed vocabulary" "ok" \
  "$("${PSQL[@]}" -c "INSERT INTO public.invitation_deliveries(auth_user_id,recipient_email,purpose,status,dispatch_state) VALUES ('$UJ','x@x.com','resume_access','claimed','dispatching')" >/dev/null 2>&1 && echo ok || echo REJECTED)"

echo "── 21. REGRESSION: internal \"char\" catalog fields are explicitly typed ──"
# Production reported `ERROR 42725: operator is not unique: text || "char"` from the preflight's
# default-privilege check. defaclobjtype is PostgreSQL's internal "char" type; both
# `anynonarray || text` and `text || anynonarray` match, so the planner refuses rather than guessing.
# This section proves the ambiguity is REAL in this PostgreSQL, and that the shipped file no longer
# triggers it.
chk "the bare concatenation IS ambiguous here (control is valid)" "rejected" \
  "$("${PSQL[@]}" -c "SELECT 'x' || d.defaclobjtype FROM pg_default_acl d" >/dev/null 2>&1 && echo ACCEPTED || echo rejected)"
chk "an explicit ::text resolves it" "ok" \
  "$("${PSQL[@]}" -c "SELECT 'x' || d.defaclobjtype::text FROM pg_default_acl d" >/dev/null 2>&1 && echo ok || echo REJECTED)"
chk "the shipped preflight contains NO un-cast char concatenation" "0" \
  "$(grep -cE '\|\|[^|]*\b(defaclobjtype|tgenabled|contype|confdeltype|relkind|prokind|provolatile|relpersistence)\b(?!::)' supabase/audits/077_078_preflight.sql 2>/dev/null || grep -c 'defaclobjtype ||' supabase/audits/077_078_preflight.sql || true)"
chk "default-privilege rows EXIST in this cluster (the check is exercised, not skipped)" "t" \
  "$(q "SELECT count(*) > 0 FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname='public'")"
# Execute the exact expression the preflight uses, against real rows.
chk "the preflight's default-privilege expression evaluates" "ok" \
  "$("${PSQL[@]}" -c "SELECT coalesce((SELECT string_agg(pg_get_userbyid(d.defaclrole)::text || ':' || d.defaclobjtype::text || '=' || array_to_string(d.defaclacl,' '), ' | ') FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname='public'), '(none)')" >/dev/null 2>&1 && echo ok || echo REJECTED)"
chk "and it returns a NON-EMPTY value (the check still detects inherited grants)" "t" \
  "$(q "SELECT coalesce((SELECT string_agg(pg_get_userbyid(d.defaclrole)::text || ':' || d.defaclobjtype::text || '=' || array_to_string(d.defaclacl,' '), ' | ') FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname='public'), '(none)') <> '(none)'")"
chk "postgres version under test" "t" "$(q "SELECT current_setting('server_version_num')::int >= 150000")"

echo "── 22. the shipped preflight and post-apply audits actually run ──"
PRE=$("$PGBIN/psql" -U postgres -X -tA -F '|' -v ON_ERROR_STOP=1 -f supabase/audits/077_078_preflight.sql 2>&1)
printf '%s\n' "$PRE" | grep -E '(ERROR|FATAL):' | sed 's/^/    PREFLIGHT ERROR: /' || true
# NOTE: psql writes errors as `psql:<file>:<line>: ERROR:  ...`, so an anchored '^ERROR' never
# matches and the check was vacuous — it is how a 42725 in the shipped preflight reached production
# review. Match ERROR/FATAL anywhere on the line instead.
chk "preflight runs with no SQL error" "0" "$(printf '%s\n' "$PRE" | grep -cE '(ERROR|FATAL):' || true)"
chk "preflight raises no 42725 (ambiguous operator)" "0" "$(printf '%s\n' "$PRE" | grep -ci '42725\|operator is not unique' || true)"
chk "preflight reports no BLOCKER"     "0" "$(printf '%s\n' "$PRE" | grep -c '|BLOCKER|' || true)"
POST=$("$PGBIN/psql" -U postgres -X -tA -F '|' -v ON_ERROR_STOP=1 -f supabase/audits/077_078_postapply.sql 2>&1)
printf '%s\n' "$POST" | grep -E '(ERROR|FATAL):' | sed 's/^/    POSTAPPLY ERROR: /' || true
chk "post-apply runs with no SQL error" "0" "$(printf '%s\n' "$POST" | grep -cE '(ERROR|FATAL):' || true)"
chk "post-apply raises no 42725" "0" "$(printf '%s\n' "$POST" | grep -ci '42725\|operator is not unique' || true)"
chk "post-apply reports ZERO failures"  "0" "$(printf '%s\n' "$POST" | grep -c '|FAIL|' || true)"
chk "post-apply produced a real result set" "yes" "$([ "$(printf '%s\n' "$POST" | grep -c .)" -gt 20 ] && echo yes || echo no)"
printf '%s\n' "$POST" | grep '|FAIL|' | sed 's/^/    POSTAPPLY FAIL: /' || true

echo
[ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "FAILURES PRESENT"; exit 1; }
