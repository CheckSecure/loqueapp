#!/usr/bin/env bash
# Migration 089 against a disposable PostgreSQL 17 cluster. Never touches production.
set -uo pipefail
PGBIN=/opt/homebrew/opt/postgresql@17/bin
[ -x "$PGBIN/initdb" ] || { echo "PostgreSQL 17 not found"; exit 1; }
PORT=55529; DIR="$(mktemp -d)"; PASS=0; FAIL=0
cleanup(){ "$PGBIN/pg_ctl" -D "$DIR/pg" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
Q(){ "$PGBIN/psql" -U postgres -X -q -A -t -h localhost -p $PORT -d postgres -c "$1" 2>&1; }
ok(){ PASS=$((PASS+1)); echo "  ✓ $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  ✗ $1 — expected [$3], got [$2]"; }
chk(){ [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

"$PGBIN/initdb" -D "$DIR/pg" -U postgres --auth=trust --no-sync >/dev/null 2>&1 || exit 1
"$PGBIN/pg_ctl" -D "$DIR/pg" -o "-p $PORT -c listen_addresses=localhost -c fsync=off" -l "$DIR/log" -w start >/dev/null 2>&1 || exit 1

"$PGBIN/psql" -U postgres -X -q -h localhost -p $PORT -d postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE TABLE public.profiles(id uuid PRIMARY KEY, is_founding_member boolean, founding_member_expires_at timestamptz, subscription_tier text);
CREATE TABLE public.meeting_credits(user_id uuid PRIMARY KEY REFERENCES public.profiles(id), free_credits int, premium_credits int, balance int, lifetime_earned int,
 CONSTRAINT meeting_credits_balance_invariant CHECK(COALESCE(balance,0)=COALESCE(free_credits,0)+COALESCE(premium_credits,0)),
 CONSTRAINT meeting_credits_buckets_non_negative CHECK(COALESCE(free_credits,0)>=0 AND COALESCE(premium_credits,0)>=0));
CREATE TABLE public.credit_grants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,stripe_event_id text UNIQUE NOT NULL,
 stripe_session_id text UNIQUE NOT NULL,stripe_price_id text NOT NULL,credits int NOT NULL,amount_total int NOT NULL,currency text NOT NULL);
CREATE TABLE public.membership_credit_cycles(user_id uuid PRIMARY KEY REFERENCES public.profiles(id),anchor_day smallint NOT NULL,next_refill_on date NOT NULL,
 last_refill_on date,last_tier text,claimed_tier text,status text DEFAULT 'active',lease_token uuid,lease_expires_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
CREATE TABLE public.credit_refills(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid REFERENCES public.profiles(id),cycle_on date,tier text,included_credits int,
 UNIQUE(user_id,cycle_on));
CREATE FUNCTION public.effective_credit_tier(boolean,timestamptz,text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN $1 THEN 'founding' ELSE COALESCE($3,'free') END $$;
CREATE FUNCTION public.tier_included_credits(text) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT CASE $1 WHEN 'free' THEN 3 WHEN 'professional' THEN 10 WHEN 'executive' THEN 20 WHEN 'founding' THEN 15 END $$;
CREATE FUNCTION public.next_credit_refill_on(integer,date) RETURNS date LANGUAGE sql IMMUTABLE AS $$ SELECT $2 + 30 $$;
CREATE FUNCTION public.apply_credit_refill(uuid,date,uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'old'::text $$;

INSERT INTO public.profiles VALUES
 ('00000000-0000-0000-0000-000000000001',false,NULL,'professional'),
 ('00000000-0000-0000-0000-000000000002',false,NULL,'free'),
 ('00000000-0000-0000-0000-000000000003',true,NULL,'free'),
 ('00000000-0000-0000-0000-000000000004',false,NULL,'executive');
INSERT INTO public.meeting_credits VALUES
 ('00000000-0000-0000-0000-000000000001',7,0,7,7),
 ('00000000-0000-0000-0000-000000000002',30,0,30,30),
 ('00000000-0000-0000-0000-000000000003',10,25,35,35),
 ('00000000-0000-0000-0000-000000000004',10,10,20,20);
SQL

chk "preflight executes and reports READY" "$(Q "$(cat supabase/audits/089_preflight.sql)" | grep -c 'READY')" "1"
"$PGBIN/psql" -U postgres -X -q -h localhost -p $PORT -d postgres -v ON_ERROR_STOP=1 -f supabase/migrations/089_credit_capacity_reservations_and_additive_refills.sql >/dev/null || exit 1
chk "post-apply audit executes and reports PASS" "$(Q "$(cat supabase/audits/089_postapply.sql)" | grep -c 'PASS')" "1"

chk "migration creates no reservation" "$(Q 'SELECT count(*) FROM public.credit_purchase_reservations')" "0"
chk "browser cannot read reservations" "$(Q "SELECT has_table_privilege('authenticated','public.credit_purchase_reservations','SELECT')")" "f"
chk "service role can call reserve" "$(Q "SELECT has_function_privilege('service_role','public.reserve_credit_purchase(uuid,text,integer,timestamptz)','EXECUTE')")" "t"

R1=$(Q "SELECT reserve_credit_purchase('00000000-0000-0000-0000-000000000003','price_10',10,now()+interval '30 min')->>'outcome'")
chk "first reservation succeeds at 35/50" "$R1" "reserved"
R2=$(Q "SELECT reserve_credit_purchase('00000000-0000-0000-0000-000000000003','price_10',10,now()+interval '30 min')->>'outcome'")
chk "second reservation is blocked by reserved headroom" "$R2" "at_capacity"

set +e
Q "UPDATE public.meeting_credits SET premium_credits=31 WHERE user_id='00000000-0000-0000-0000-000000000003'" >/dev/null
RC=$?
set -e
chk "all writers respect an active reservation" "$RC" "1"

set +e
Q "UPDATE public.meeting_credits SET free_credits=31 WHERE user_id='00000000-0000-0000-0000-000000000002'" >/dev/null
RC=$?
set -e
chk "legacy included balance cannot increase" "$RC" "1"
Q "UPDATE public.meeting_credits SET free_credits=29 WHERE user_id='00000000-0000-0000-0000-000000000002'" >/dev/null
chk "legacy included balance may fall" "$(Q "SELECT free_credits FROM public.meeting_credits WHERE user_id='00000000-0000-0000-0000-000000000002'")" "29"

TOKEN=11111111-1111-1111-1111-111111111111
Q "INSERT INTO public.membership_credit_cycles(user_id,anchor_day,next_refill_on,claimed_tier,lease_token,lease_expires_at) VALUES('00000000-0000-0000-0000-000000000001',1,current_date,'professional','$TOKEN',now()+interval '2 min')" >/dev/null
chk "due cycle is applied" "$(Q "SELECT apply_credit_refill('00000000-0000-0000-0000-000000000001',current_date,'$TOKEN')")" "refilled"
chk "refill adds 10 instead of replacing 7" "$(Q "SELECT free_credits FROM public.meeting_credits WHERE user_id='00000000-0000-0000-0000-000000000001'")" "17"
chk "refill ledger records actual additive grant" "$(Q "SELECT included_credits FROM public.credit_refills WHERE user_id='00000000-0000-0000-0000-000000000001'")" "10"

RID=$(Q "SELECT id FROM public.credit_purchase_reservations WHERE user_id='00000000-0000-0000-0000-000000000003'")
chk "bind succeeds" "$(Q "SELECT bind_credit_purchase_reservation('$RID','00000000-0000-0000-0000-000000000003','cs_test_1',now()+interval '30 min')")" "bound"
chk "bound reservation cannot be released as creation failure" "$(Q "SELECT release_credit_purchase_reservation('$RID',NULL,'checkout_creation_failed')")" "conflict"
chk "Stripe-confirmed expiry releases it" "$(Q "SELECT release_credit_purchase_reservation('$RID','cs_test_1','stripe_expired')")" "released"

RID2=$(Q "SELECT reserve_credit_purchase('00000000-0000-0000-0000-000000000003','price_10',10,now()+interval '30 min')->>'reservation_id'")
Q "SELECT bind_credit_purchase_reservation('$RID2','00000000-0000-0000-0000-000000000003','cs_test_2',now()+interval '30 min')" >/dev/null
chk "reserved grant is fulfilled" "$(Q "SELECT grant_reserved_credit_pack('$RID2','evt_test_2','cs_test_2','00000000-0000-0000-0000-000000000003','price_10',10,4500,'usd')")" "granted"
chk "grant is idempotent" "$(Q "SELECT grant_reserved_credit_pack('$RID2','evt_test_2','cs_test_2','00000000-0000-0000-0000-000000000003','price_10',10,4500,'usd')")" "already_processed"
chk "purchased grant reaches 45, not above 50" "$(Q "SELECT balance FROM public.meeting_credits WHERE user_id='00000000-0000-0000-0000-000000000003'")" "45"

# Two sessions race for 25 credits each while only 30 total headroom exists. The per-user advisory
# lock must serialize them, leaving exactly one reservation and never overselling to 70.
(Q "BEGIN; SELECT reserve_credit_purchase('00000000-0000-0000-0000-000000000004','price_25',25,now()+interval '30 min')->>'outcome'; SELECT pg_sleep(1); COMMIT" >"$DIR/race1" ) & P1=$!
sleep 0.1
(Q "SELECT reserve_credit_purchase('00000000-0000-0000-0000-000000000004','price_25',25,now()+interval '30 min')->>'outcome'" >"$DIR/race2" ) & P2=$!
wait $P1; wait $P2
chk "concurrent reservations cannot oversell" "$(Q "SELECT count(*)||':'||sum(credits) FROM public.credit_purchase_reservations WHERE user_id='00000000-0000-0000-0000-000000000004' AND status='reserved'")" "1:25"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
