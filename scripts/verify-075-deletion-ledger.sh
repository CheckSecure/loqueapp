#!/usr/bin/env bash
# Verifies migration 075 against a real PostgreSQL cluster that REPRODUCES SUPABASE'S INHERITED
# DEFAULT PRIVILEGES. A plain local cluster has none of them, which is precisely why three earlier
# ACL defects (070, 072, 074) passed local verification and only failed in production.
set -euo pipefail
PGBIN=/opt/homebrew/opt/postgresql@17/bin
DATA=$(mktemp -d)/pg75; PORT=55475
export PGHOST=127.0.0.1 PGPORT=$PORT PGDATABASE=postgres
cleanup(){ "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c listen_addresses=127.0.0.1" -l "$DATA/log" -w start >/dev/null
PSQL=("$PGBIN/psql" -U postgres -v ON_ERROR_STOP=1 -X -q)

"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- ── THE WHOLE POINT: reproduce Supabase's project-level default privileges. ──
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT current_setting('test.uid', true)::uuid$$;
CREATE TABLE public.profiles (id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, email text);
CREATE TABLE public.matches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_a_id uuid, user_b_id uuid);
CREATE TABLE public.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), match_id uuid REFERENCES public.matches(id) ON DELETE CASCADE);
CREATE TABLE public.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sender_id uuid, body text);
CREATE TABLE public.intro_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requester_id uuid, target_user_id uuid);
CREATE TABLE public.meetings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requester_id uuid, recipient_id uuid);
CREATE TABLE public.meeting_credits (user_id uuid PRIMARY KEY);
CREATE TABLE public.credit_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
CREATE TABLE public.notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
CREATE TABLE public.waitlist (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
SQL

"${PSQL[@]}" -f supabase/migrations/075_account_deletion_ledger.sql >/dev/null
echo "  migration 075 applied cleanly under Supabase-style default privileges"

# ── REPRODUCE THE PRODUCTION DEFECT BEFORE FIXING IT ──────────────────────────────────────────
# Two defaults stack: PostgreSQL grants EXECUTE on every new function to PUBLIC by itself, and the
# ALTER DEFAULT PRIVILEGES above adds anon/authenticated/service_role entries. 075 revoked on six of
# its seven functions and missed the append-only trigger function. If this cluster does not show the
# defect, the harness is not modelling production and its later PASS would be meaningless.
PRE_PUBLIC=$("$PGBIN/psql" -U postgres -tAc "SELECT (proacl IS NULL) OR EXISTS (SELECT 1 FROM unnest(proacl) a WHERE a::text LIKE '=%') FROM pg_proc WHERE oid = to_regprocedure('public.tg_account_deletion_events_append_only()')")
PRE_ANON=$("$PGBIN/psql" -U postgres -tAc "SELECT has_function_privilege('anon','public.tg_account_deletion_events_append_only()','EXECUTE')")
echo "  defect reproduced before 076 — PUBLIC can execute: $PRE_PUBLIC, anon can execute: $PRE_ANON"

"${PSQL[@]}" -f supabase/migrations/076_account_deletion_ledger_acl_correction.sql >/dev/null
echo "  migration 076 applied"
fail=0
chk(){ if [ "$2" = "$3" ]; then printf '  ok   %-60s %s\n' "$1" "$3"
       else printf '  FAIL %-60s expected=%s actual=%s\n' "$1" "$2" "$3"; fail=1; fi; }
q(){ "${PSQL[@]}" -tAc "$1"; }
mk(){ "${PSQL[@]}" -c "INSERT INTO auth.users VALUES ('$1','$2'); INSERT INTO public.profiles VALUES ('$1','$2');" >/dev/null; }
stages(){ q "SELECT string_agg(stage,',' ORDER BY occurred_at) FROM public.account_deletion_events WHERE deletion_id='$1'"; }
# Canonical SET of stages, order-independent. Needed because a cascade deletion fires the auth.users
# trigger BEFORE the profile cascade, so the true chronological order there is
# requested -> auth_deleted -> data_deleted. Asserting a fixed timeline would assert a fiction; the
# guarantee is that every transition is present, not that they happen in narrative order.
stageset(){ q "SELECT string_agg(DISTINCT stage,',' ORDER BY stage) FROM public.account_deletion_events WHERE deletion_id='$1'"; }

echo "── 1. exact service_role privileges under inherited GRANT ALL ──"
for r in anon authenticated; do
  chk "$r has NO table privilege at all" "" \
    "$(q "SELECT string_agg(privilege_type,',') FROM information_schema.role_table_grants WHERE table_name='account_deletion_events' AND grantee='$r'")"
done
chk "service_role has exactly INSERT,SELECT" "INSERT,SELECT" \
  "$(q "SELECT string_agg(privilege_type,',' ORDER BY privilege_type) FROM information_schema.role_table_grants WHERE table_name='account_deletion_events' AND grantee='service_role'")"
for v in UPDATE DELETE TRUNCATE REFERENCES TRIGGER; do
  for r in anon authenticated service_role; do
    chk "$r CANNOT $v" "f" "$(q "SELECT has_table_privilege('$r','public.account_deletion_events','$v')")"
  done
done
chk "RLS enabled" "t" "$(q "SELECT relrowsecurity FROM pg_class WHERE oid='public.account_deletion_events'::regclass")"
chk "zero policies — no browser-readable deletion history" "0" "$(q "SELECT count(*) FROM pg_policies WHERE tablename='account_deletion_events'")"
chk "no FK on the ledger (must outlive its subject)" "0" "$(q "SELECT count(*) FROM pg_constraint WHERE conrelid='public.account_deletion_events'::regclass AND contype='f'")"
for f in record_account_deletion_event tg_capture_account_deletion tg_account_deletion_events_append_only account_deletion_counts_ok tg_capture_profiles_truncate; do
  chk "$f pins empty search_path" 'search_path=""' "$(q "SELECT array_to_string(proconfig,',') FROM pg_proc WHERE proname='$f'")"
done
chk "anon cannot execute the recorder" "f" "$(q "SELECT has_function_privilege('anon','public.record_account_deletion_event(uuid,text,text,text,uuid,text,jsonb,text)','EXECUTE')")"
chk "authenticated cannot execute the recorder" "f" "$(q "SELECT has_function_privilege('authenticated','public.record_account_deletion_event(uuid,text,text,text,uuid,text,jsonb,text)','EXECUTE')")"
chk "service_role CAN execute the recorder" "t" "$(q "SELECT has_function_privilege('service_role','public.record_account_deletion_event(uuid,text,text,text,uuid,text,jsonb,text)','EXECUTE')")"
chk "authenticated CAN still self-delete" "t" "$(q "SELECT has_function_privilege('authenticated','public.delete_user_account()','EXECUTE')")"

echo "── 2. ledger rows cannot be updated, deleted or truncated — even by the OWNER ──"
"${PSQL[@]}" -c "SELECT public.record_account_deletion_event('11111111-1111-1111-1111-111111111111','requested','admin','admin_invite_revoke',NULL,'invitation_revoked','{\"matches\":2}'::jsonb,NULL)" >/dev/null
chk "row written" "1" "$(q "SELECT count(*) FROM public.account_deletion_events")"
for op in "UPDATE public.account_deletion_events SET stage='failed'" "DELETE FROM public.account_deletion_events" "TRUNCATE public.account_deletion_events"; do
  if "${PSQL[@]}" -c "$op" >/dev/null 2>&1; then chk "superuser blocked: ${op%% *} ${op#* }" "blocked" "ALLOWED"
  else chk "superuser/owner blocked from ${op%% *}" "blocked" "blocked"; fi
done
"${PSQL[@]}" -c "SELECT public.record_account_deletion_event('11111111-1111-1111-1111-111111111111','requested','admin','admin_invite_revoke',NULL,'invitation_revoked',NULL,NULL)" >/dev/null
chk "duplicate/retry is idempotent (no second row)" "1" "$(q "SELECT count(*) FROM public.account_deletion_events")"

echo "── 3. no PII can be retained ──"
for bad in '{"email":"a@b.com"}' '{"name":"Alexander"}' '{"matches":-1}' '{"matches":1.5}'; do
  if "${PSQL[@]}" -c "INSERT INTO public.account_deletion_events(deletion_id,event_key,stage,actor_category,deletion_path,object_counts) VALUES(gen_random_uuid(),'k-$RANDOM$RANDOM','requested','self','self_service_rpc','$bad'::jsonb)" >/dev/null 2>&1
  then chk "object_counts rejects $bad" "rejected" "ACCEPTED"; else chk "object_counts rejects $bad" "rejected" "rejected"; fi
done
if "${PSQL[@]}" -c "INSERT INTO public.account_deletion_events(deletion_id,event_key,stage,actor_category,deletion_path,error_class) VALUES(gen_random_uuid(),'e1','failed','self','self_service_rpc','duplicate key value violates unique constraint')" >/dev/null 2>&1
then chk "error_class rejects a raw SQL error" "rejected" "ACCEPTED"; else chk "error_class rejects a raw SQL error" "rejected" "rejected"; fi
if "${PSQL[@]}" -c "INSERT INTO public.account_deletion_events(deletion_id,event_key,stage,actor_category,deletion_path,error_class) VALUES(gen_random_uuid(),'e2','data_deleted','self','self_service_rpc','timeout')" >/dev/null 2>&1
then chk "error_class only on the failed stage" "rejected" "ACCEPTED"; else chk "error_class only on the failed stage" "rejected" "rejected"; fi
chk "no column can hold email/name/body/ip/token" "" \
  "$(q "SELECT string_agg(column_name,',') FROM information_schema.columns WHERE table_name='account_deletion_events' AND (column_name ~* 'email|name|body|content|ip_|token|payload|snapshot')")"

echo "── 4. PATH 1: self-service delete writes the ledger, data still removed ──"
U1=22222222-2222-2222-2222-222222222222
mk $U1 'gone@example.com'
"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO public.waitlist(email) VALUES ('gone@example.com');
INSERT INTO public.matches(user_a_id,user_b_id) VALUES ('$U1',gen_random_uuid());
INSERT INTO public.conversations(match_id) SELECT id FROM public.matches;
INSERT INTO public.messages(sender_id,body) VALUES ('$U1','secret text');
SET test.uid = '$U1';
SELECT public.delete_user_account();
SQL
chk "profile removed" "0" "$(q "SELECT count(*) FROM public.profiles WHERE id='$U1'")"
chk "auth user removed" "0" "$(q "SELECT count(*) FROM auth.users WHERE id='$U1'")"
chk "waitlist removed" "0" "$(q "SELECT count(*) FROM public.waitlist WHERE email='gone@example.com'")"
chk "matches removed" "0" "$(q "SELECT count(*) FROM public.matches")"
chk "lifecycle recorded" "requested,data_deleted,auth_deleted" "$(stages $U1)"
chk "exactly 3 events — trigger did NOT duplicate" "3" "$(q "SELECT count(*) FROM public.account_deletion_events WHERE deletion_id='$U1'")"
chk "actor is self (not overwritten by the trigger)" "self" "$(q "SELECT DISTINCT actor_category FROM public.account_deletion_events WHERE deletion_id='$U1'")"
chk "path is self_service_rpc" "self_service_rpc" "$(q "SELECT DISTINCT deletion_path FROM public.account_deletion_events WHERE deletion_id='$U1'")"
chk "counts captured BEFORE deletion (messages=1)" "1" "$(q "SELECT object_counts->>'messages' FROM public.account_deletion_events WHERE deletion_id='$U1' AND stage='requested'")"
chk "ledger holds no message content" "0" "$(q "SELECT count(*) FROM public.account_deletion_events WHERE to_jsonb(account_deletion_events)::text ILIKE '%secret text%'")"
chk "ledger holds no email address" "0" "$(q "SELECT count(*) FROM public.account_deletion_events WHERE to_jsonb(account_deletion_events)::text ILIKE '%gone@example.com%'")"

echo "── 5. PATH 2: admin-style deletion (separate statements, as the app does it) ──"
U2=44444444-4444-4444-4444-444444444444
mk $U2 'admin@example.com'
"${PSQL[@]}" -c "SELECT public.record_account_deletion_event('$U2','requested','admin','admin_invite_revoke','$U2','invitation_revoked',NULL,NULL)" >/dev/null
"${PSQL[@]}" -c "DELETE FROM public.profiles WHERE id='$U2'" >/dev/null
"${PSQL[@]}" -c "DELETE FROM auth.users WHERE id='$U2'" >/dev/null
chk "lifecycle recorded" "requested,data_deleted,auth_deleted" "$(stages $U2)"
chk "actor stays admin (trigger INHERITED attribution)" "admin" "$(q "SELECT DISTINCT actor_category FROM public.account_deletion_events WHERE deletion_id='$U2'")"
chk "path stays admin_invite_revoke" "admin_invite_revoke" "$(q "SELECT DISTINCT deletion_path FROM public.account_deletion_events WHERE deletion_id='$U2'")"
chk "no duplicate lifecycle minted" "3" "$(q "SELECT count(*) FROM public.account_deletion_events WHERE deletion_id='$U2'")"

echo "── 6. PATH 3/4/5: OUT-OF-BAND deletion is captured with no app involvement ──"
U3=55555555-5555-5555-5555-555555555555
mk $U3 'oob@example.com'
"${PSQL[@]}" -c "DELETE FROM auth.users WHERE id='$U3'" >/dev/null   # dashboard / Auth Admin API shape
chk "captured despite no application code" "auth_deleted,data_deleted,requested" "$(stageset $U3)"
# The real chronology, recorded rather than smoothed over: DELETE FROM auth.users fires our BEFORE
# trigger first, and the profile row is only removed afterwards by ON DELETE CASCADE.
chk "cascade chronology recorded truthfully" "requested,auth_deleted,data_deleted" "$(stages $U3)"
chk "honestly attributed to system" "system" "$(q "SELECT DISTINCT actor_category FROM public.account_deletion_events WHERE deletion_id='$U3'")"
chk "honestly attributed to out_of_band" "out_of_band" "$(q "SELECT DISTINCT deletion_path FROM public.account_deletion_events WHERE deletion_id='$U3'")"
U4=66666666-6666-6666-6666-666666666666
mk $U4 'profonly@example.com'
"${PSQL[@]}" -c "DELETE FROM public.profiles WHERE id='$U4'" >/dev/null   # PATH 3: profile deletion alone
chk "profile-only deletion captured" "requested,data_deleted" "$(stages $U4)"
chk "and is distinguishable from a COMPLETED deletion" "0" \
  "$(q "SELECT count(*) FROM public.account_deletion_events WHERE deletion_id='$U4' AND stage='auth_deleted'")"

echo "── 7. bulk TRUNCATE of profiles does not vanish silently ──"
mk 77777777-7777-7777-7777-777777777777 't@example.com'
B=$(q "SELECT count(*) FROM public.account_deletion_events")
"${PSQL[@]}" -c "TRUNCATE public.profiles" >/dev/null
chk "a bulk-removal event was recorded" "1" "$(q "SELECT count(*) FROM public.account_deletion_events WHERE object_counts ? 'profiles_truncated'")"
chk "with a count and a NULL subject" "1" \
  "$(q "SELECT count(*) FROM public.account_deletion_events WHERE object_counts ? 'profiles_truncated' AND deleted_user_id IS NULL")"

echo "── 8. completed vs failed transitions are distinguishable ──"
U5=88888888-8888-8888-8888-888888888888
"${PSQL[@]}" -c "SELECT public.record_account_deletion_event('$U5','requested','admin','admin_invite_revoke','$U5','invitation_revoked',NULL,NULL); SELECT public.record_account_deletion_event('$U5','failed','admin','admin_invite_revoke','$U5','invitation_revoked',NULL,'auth_api_error');" >/dev/null
chk "failed lifecycle has no auth_deleted" "0" "$(q "SELECT count(*) FROM public.account_deletion_events WHERE deletion_id='$U5' AND stage='auth_deleted'")"
chk "failure class is retained" "auth_api_error" "$(q "SELECT error_class FROM public.account_deletion_events WHERE deletion_id='$U5' AND stage='failed'")"
chk "COMPLETED deletions are queryable" "2" \
  "$(q "SELECT count(*) FROM public.account_deletion_events WHERE stage='auth_deleted' AND deletion_id IN ('$U1','$U2','$U5')")"

echo "── 9. RETENTION PURGE: exact signature, fixed boundary, no caller control ──"
chk "returns bigint" "bigint" "$(q "SELECT pg_get_function_result(to_regprocedure('public.purge_expired_account_deletion_events()'))")"
chk "takes NO arguments (no id/date/interval to aim it)" "" \
  "$(q "SELECT pg_get_function_identity_arguments(to_regprocedure('public.purge_expired_account_deletion_events()'))")"
chk "SECURITY DEFINER" "t" "$(q "SELECT prosecdef FROM pg_proc WHERE proname='purge_expired_account_deletion_events'")"
chk "empty search_path" 'search_path=""' "$(q "SELECT array_to_string(proconfig,',') FROM pg_proc WHERE proname='purge_expired_account_deletion_events'")"
chk "seven-year cutoff is fixed in the body" "1" \
  "$(q "SELECT count(*) FROM pg_proc WHERE proname='purge_expired_account_deletion_events' AND prosrc LIKE '%make_interval(years => 7)%'")"
chk "body contains no interval/date parameter" "0" \
  "$(q "SELECT count(*) FROM pg_proc WHERE proname='purge_expired_account_deletion_events' AND (prosrc ~ 'p_[a-z_]*(days|date|interval|years|user|email)' OR pronargs > 0)")"
# PUBLIC is not a role, so has_function_privilege cannot take it — inspect the ACL. A PUBLIC grant
# renders as a bare "=X/owner" entry with an empty grantee; its absence is the proof.
chk "PUBLIC CANNOT execute the purge" "0" \
  "$(q "SELECT count(*) FROM pg_proc p, unnest(coalesce(p.proacl, ARRAY[]::aclitem[])) a WHERE p.proname='purge_expired_account_deletion_events' AND a::text LIKE '=%'")"
for r in anon authenticated; do
  chk "$r CANNOT execute the purge" "f" "$(q "SELECT has_function_privilege('$r','public.purge_expired_account_deletion_events()','EXECUTE')")"
done
chk "service_role CAN execute the purge" "t" "$(q "SELECT has_function_privilege('service_role','public.purge_expired_account_deletion_events()','EXECUTE')")"

echo "── 10. purge removes ONLY expired rows; boundary rows survive ──"
"${PSQL[@]}" -c "SELECT public.record_account_deletion_event('a0000000-0000-0000-0000-00000000000$RANDOM'::uuid,'requested','system','out_of_band',NULL,'unspecified',NULL,NULL)" >/dev/null 2>&1 || true
# Ageing rows requires bypassing append-only for the fixture, so build them by inserting directly
# with an explicit occurred_at — INSERT is the one verb the table permits.
"${PSQL[@]}" <<'SQL' >/dev/null
INSERT INTO public.account_deletion_events(deletion_id,event_key,stage,actor_category,deletion_path,deleted_user_id,occurred_at)
VALUES (gen_random_uuid(),'age:old',       'auth_deleted','system','out_of_band',gen_random_uuid(), now() - interval '7 years 1 day'),
       (gen_random_uuid(),'age:boundary',  'auth_deleted','system','out_of_band',gen_random_uuid(), now() - interval '6 years 364 days'),
       (gen_random_uuid(),'age:exactly7',  'auth_deleted','system','out_of_band',gen_random_uuid(), now() - interval '7 years' + interval '1 second'),
       (gen_random_uuid(),'age:fresh',     'auth_deleted','system','out_of_band',gen_random_uuid(), now());
SQL
REMOVED=$(q "SELECT public.purge_expired_account_deletion_events()")
chk "purge returned an aggregate count only" "1" "$REMOVED"
chk "older-than-seven-years row REMOVED" "0" "$(q "SELECT count(*) FROM public.account_deletion_events WHERE event_key='age:old'")"
chk "six-years-364-days row REMAINS" "1" "$(q "SELECT count(*) FROM public.account_deletion_events WHERE event_key='age:boundary'")"
chk "one-second-inside-seven-years row REMAINS" "1" "$(q "SELECT count(*) FROM public.account_deletion_events WHERE event_key='age:exactly7'")"
chk "fresh row REMAINS" "1" "$(q "SELECT count(*) FROM public.account_deletion_events WHERE event_key='age:fresh'")"
chk "purge retry is idempotent (nothing left to remove)" "0" "$(q "SELECT public.purge_expired_account_deletion_events()")"
chk "purge return type carries no identity" "bigint" "$(q "SELECT pg_get_function_result(to_regprocedure('public.purge_expired_account_deletion_events()'))")"

echo "── 11. the purge door cannot be propped open ──"
if "${PSQL[@]}" -c "SET LOCAL andrel.retention_purge='on'; DELETE FROM public.account_deletion_events WHERE event_key='age:fresh';" >/dev/null 2>&1
then chk "marker alone cannot delete a young row" "blocked" "ALLOWED"; else chk "marker alone cannot delete a young row" "blocked" "blocked"; fi
chk "young row survived the attempt" "1" "$(q "SELECT count(*) FROM public.account_deletion_events WHERE event_key='age:fresh'")"
if "${PSQL[@]}" -c "DELETE FROM public.account_deletion_events WHERE event_key='age:boundary'" >/dev/null 2>&1
then chk "ordinary DELETE still blocked after purge ran" "blocked" "ALLOWED"; else chk "ordinary DELETE still blocked after purge ran" "blocked" "blocked"; fi
if "${PSQL[@]}" -c "UPDATE public.account_deletion_events SET stage='failed'" >/dev/null 2>&1
then chk "ordinary UPDATE still blocked" "blocked" "ALLOWED"; else chk "ordinary UPDATE still blocked" "blocked" "blocked"; fi
if "${PSQL[@]}" -c "TRUNCATE public.account_deletion_events" >/dev/null 2>&1
then chk "TRUNCATE still blocked" "blocked" "ALLOWED"; else chk "TRUNCATE still blocked" "blocked" "blocked"; fi
chk "marker does not leak out of the purge transaction" "" "$(q "SELECT current_setting('andrel.retention_purge', true)")"

echo "── 12. idempotent reapplication of the whole migration ──"
"${PSQL[@]}" -f supabase/migrations/075_account_deletion_ledger.sql >/dev/null
chk "re-apply succeeded and preserved rows" "3" "$(q "SELECT count(*) FROM public.account_deletion_events WHERE event_key LIKE 'age:%'")"
chk "grants unchanged after re-apply" "INSERT,SELECT" \
  "$(q "SELECT string_agg(privilege_type,',' ORDER BY privilege_type) FROM information_schema.role_table_grants WHERE table_name='account_deletion_events' AND grantee='service_role'")"
chk "all capture triggers still enabled" "0" \
  "$(q "SELECT count(*) FROM pg_trigger WHERE tgname IN ('capture_profile_deletion','capture_auth_user_deletion','capture_profiles_truncate','account_deletion_events_append_only','account_deletion_events_no_truncate') AND tgenabled='D'")"

echo "── 13. MIGRATION 076: the append-only function ACL correction ──"
chk "the defect WAS present before 076 (PUBLIC)" "t" "$PRE_PUBLIC"
chk "the defect WAS present before 076 (anon)" "t" "$PRE_ANON"
chk "PUBLIC cannot execute it now" "0" \
  "$(q "SELECT count(*) FROM pg_proc p, unnest(coalesce(p.proacl, ARRAY[]::aclitem[])) a WHERE p.oid=to_regprocedure('public.tg_account_deletion_events_append_only()') AND a::text LIKE '=%'")"
chk "proacl is not NULL (NULL means the PG default: PUBLIC executes)" "f" \
  "$(q "SELECT proacl IS NULL FROM pg_proc WHERE oid=to_regprocedure('public.tg_account_deletion_events_append_only()')")"
chk "anon cannot execute it now" "f" "$(q "SELECT has_function_privilege('anon','public.tg_account_deletion_events_append_only()','EXECUTE')")"
chk "authenticated cannot execute it now" "f" "$(q "SELECT has_function_privilege('authenticated','public.tg_account_deletion_events_append_only()','EXECUTE')")"
chk "service_role CAN execute it" "t" "$(q "SELECT has_function_privilege('service_role','public.tg_account_deletion_events_append_only()','EXECUTE')")"
chk "function still exists" "1" "$(q "SELECT count(*) FROM pg_proc WHERE oid=to_regprocedure('public.tg_account_deletion_events_append_only()')")"
chk "still SECURITY DEFINER" "t" "$(q "SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure('public.tg_account_deletion_events_append_only()')")"
chk "still empty search_path" 'search_path=""' "$(q "SELECT array_to_string(proconfig,',') FROM pg_proc WHERE oid=to_regprocedure('public.tg_account_deletion_events_append_only()')")"
chk "body UNCHANGED by 076" "t" \
  "$(q "SELECT prosrc LIKE '%andrel.retention_purge%' AND prosrc LIKE '%make_interval(years => 7)%' AND prosrc LIKE '%insufficient_privilege%' FROM pg_proc WHERE oid=to_regprocedure('public.tg_account_deletion_events_append_only()')")"
chk "append-only trigger present and enabled" "1" \
  "$(q "SELECT count(*) FROM pg_trigger WHERE tgname='account_deletion_events_append_only' AND NOT tgisinternal AND tgenabled<>'D'")"
chk "truncate-guard trigger present and enabled" "1" \
  "$(q "SELECT count(*) FROM pg_trigger WHERE tgname='account_deletion_events_no_truncate' AND NOT tgisinternal AND tgenabled<>'D'")"
echo "  -- append-only still WORKS after the revoke (trigger machinery ignores EXECUTE grants) --"
if "${PSQL[@]}" -c "UPDATE public.account_deletion_events SET stage='failed'" >/dev/null 2>&1
then chk "UPDATE still blocked after 076" "blocked" "ALLOWED"; else chk "UPDATE still blocked after 076" "blocked" "blocked"; fi
if "${PSQL[@]}" -c "TRUNCATE public.account_deletion_events" >/dev/null 2>&1
then chk "TRUNCATE still blocked after 076" "blocked" "ALLOWED"; else chk "TRUNCATE still blocked after 076" "blocked" "blocked"; fi

echo "── 14. NO ledger function is executable by PUBLIC or a browser role ──"
for fn in record_account_deletion_event tg_capture_account_deletion tg_account_deletion_events_append_only account_deletion_counts_ok tg_capture_profiles_truncate purge_expired_account_deletion_events; do
  chk "$fn: PUBLIC cannot execute" "f" \
    "$(q "SELECT (proacl IS NULL) OR EXISTS (SELECT 1 FROM unnest(proacl) a WHERE a::text LIKE '=%') FROM pg_proc WHERE proname='$fn'")"
  chk "$fn: anon cannot execute" "f" "$(q "SELECT has_function_privilege('anon', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.proname='$fn'")"
done
chk "delete_user_account: PUBLIC cannot execute" "f" \
  "$(q "SELECT (proacl IS NULL) OR EXISTS (SELECT 1 FROM unnest(proacl) a WHERE a::text LIKE '=%') FROM pg_proc WHERE proname='delete_user_account'")"
chk "delete_user_account: authenticated CAN (members self-delete)" "t" \
  "$(q "SELECT has_function_privilege('authenticated','public.delete_user_account()','EXECUTE')")"

echo "── 15. 076 is idempotent ──"
"${PSQL[@]}" -f supabase/migrations/076_account_deletion_ledger_acl_correction.sql >/dev/null
chk "re-apply succeeded, end state unchanged" "f" "$(q "SELECT has_function_privilege('anon','public.tg_account_deletion_events_append_only()','EXECUTE')")"
chk "service_role still holds EXECUTE" "t" "$(q "SELECT has_function_privilege('service_role','public.tg_account_deletion_events_append_only()','EXECUTE')")"

echo "── 16. RUN THE REAL POST-APPLY AUDIT, not a paraphrase of it ──"
#
# WHY THIS SECTION EXISTS. Every check above re-states an assertion in its own words. That is how a
# false failure reached production: the audit compared proconfig against 'search_path=' while this
# harness compared against 'search_path=""'. Both "passed" on their own terms and disagreed with each
# other, and nothing noticed until the operator ran the audit for real. The harness now EXECUTES the
# shipped audit file against the migration-defined functions, so the artifact the operator runs is
# the artifact that is tested.
AUDIT_OUT=$("$PGBIN/psql" -U postgres -X -tA -F '|' -f supabase/audits/075_postapply.sql 2>&1)
AUDIT_LINES=$(printf '%s\n' "$AUDIT_OUT" | grep -c .)
chk "the audit produced output (an empty run must not pass)" "yes" "$([ "$AUDIT_LINES" -gt 30 ] && echo yes || echo "no:$AUDIT_LINES")"
chk "the audit reported ZERO failures" "0" "$(printf '%s\n' "$AUDIT_OUT" | grep -c '|FAIL|' || true)"
chk "the audit raised no SQL error" "0" "$(printf '%s\n' "$AUDIT_OUT" | grep -ci '^ERROR:' || true)"
# The specific assertion that produced the false failure, asserted by name.
chk "audit: 'still pins an empty search_path' => PASS" "PASS" \
  "$(printf '%s\n' "$AUDIT_OUT" | grep 'still pins an empty search_path' | cut -d'|' -f3)"
chk "audit: purge 'SECURITY DEFINER with empty search_path' => PASS" "PASS" \
  "$(printf '%s\n' "$AUDIT_OUT" | grep 'SECURITY DEFINER with empty search_path' | cut -d'|' -f3)"
chk "audit: append-only function ACL assertions all PASS" "0" \
  "$(printf '%s\n' "$AUDIT_OUT" | grep '^5\. append-only function ACL' | grep -c '|FAIL|' || true)"
# Every listed function must report search_path_pinned_empty = t in sections 5b/5c.
chk "no function reports search_path_pinned_empty = false" "0" \
  "$(q "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('record_account_deletion_event','tg_capture_account_deletion','tg_account_deletion_events_append_only','account_deletion_counts_ok','tg_capture_profiles_truncate','purge_expired_account_deletion_events','delete_user_account') AND NOT ('search_path=\"\"' = ANY(p.proconfig))")"
# And prove the storage representation directly, so the expected literal is grounded in fact.
chk "PostgreSQL stores the empty pin as search_path=\"\"" 't' \
  "$(q "SELECT 'search_path=\"\"' = ANY(proconfig) FROM pg_proc WHERE oid=to_regprocedure('public.tg_account_deletion_events_append_only()')")"
chk "and NOT as the unquoted 'search_path='" 'f' \
  "$(q "SELECT 'search_path=' = ANY(proconfig) FROM pg_proc WHERE oid=to_regprocedure('public.tg_account_deletion_events_append_only()')")"

echo "── 17. FAIL-CLOSED: an unwritable ledger prevents deletion ──"
U6=33333333-3333-3333-3333-333333333333
mk $U6 'stays@example.com'
"${PSQL[@]}" -c "INSERT INTO public.matches(user_a_id,user_b_id) VALUES ('$U6',gen_random_uuid())" >/dev/null
"${PSQL[@]}" -c "ALTER TABLE public.account_deletion_events ADD CONSTRAINT tmp_break CHECK (false) NOT VALID" >/dev/null
set +e
"${PSQL[@]}" -c "SET test.uid='$U6'; SELECT public.delete_user_account();" >/dev/null 2>&1; rc_self=$?
"${PSQL[@]}" -c "DELETE FROM auth.users WHERE id='$U6'" >/dev/null 2>&1; rc_oob=$?
set -e
chk "self-service deletion REFUSED" "1" "$([ $rc_self -ne 0 ] && echo 1 || echo 0)"
chk "out-of-band deletion also REFUSED" "1" "$([ $rc_oob -ne 0 ] && echo 1 || echo 0)"
chk "profile still present (rolled back)" "1" "$(q "SELECT count(*) FROM public.profiles WHERE id='$U6'")"
chk "match still present (rolled back)" "1" "$(q "SELECT count(*) FROM public.matches WHERE user_a_id='$U6'")"
chk "auth user still present (rolled back)" "1" "$(q "SELECT count(*) FROM auth.users WHERE id='$U6'")"
"${PSQL[@]}" -c "ALTER TABLE public.account_deletion_events DROP CONSTRAINT tmp_break" >/dev/null

echo
[ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "FAILURES PRESENT"; exit 1; }
