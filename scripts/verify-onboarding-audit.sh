#!/usr/bin/env bash
# Proves the onboarding-resume audit against a real PostgreSQL cluster, on fixtures designed to
# break it. Destroys the cluster afterwards. Runs NOTHING against production.
set -euo pipefail
PGBIN=/opt/homebrew/opt/postgresql@17/bin
DATA=$(mktemp -d)/pgoa; PORT=55480
export PGHOST=127.0.0.1 PGPORT=$PORT PGDATABASE=postgres
cleanup(){ "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -c listen_addresses=127.0.0.1" -l "$DATA/log" -w start >/dev/null
PSQL=("$PGBIN/psql" -U postgres -v ON_ERROR_STOP=1 -X -q)
q(){ "${PSQL[@]}" -tAc "$1"; }
fail=0
chk(){ if [ "$2" = "$3" ]; then printf '  ok   %-64s %s\n' "$1" "$3"
       else printf '  FAIL %-64s expected=%s actual=%s\n' "$1" "$2" "$3"; fail=1; fi; }

"${PSQL[@]}" <<'SQL'
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text,
                         last_sign_in_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, profile_complete boolean,
                              onboarding_step int, updated_at timestamptz, is_admin boolean DEFAULT false);
CREATE TABLE public.waitlist (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, status text,
                              invited_at timestamptz, invite_reminder_1_sent_at timestamptz,
                              invite_reminder_2_sent_at timestamptz);
CREATE TABLE public.invitation_deliveries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                              recipient_email text NOT NULL, purpose text, status text);

-- ── NEGATIVE CONTROL: two DIFFERENT addresses whose masks are IDENTICAL. ──
-- arato@tkogrp.com -> a***o@tkogrp.com ; alberto@tkogrp.com -> a***o@tkogrp.com
-- The old query grouped on that mask and reported them as a duplicate. They are not.
INSERT INTO auth.users(email) VALUES ('arato@tkogrp.com'), ('alberto@tkogrp.com');
INSERT INTO public.waitlist(email,status,invited_at) VALUES
  ('arato@tkogrp.com','invited', now() - interval '10 days'),
  ('alberto@tkogrp.com','invited', now() - interval '10 days');
-- a second colliding pair, different shape: daniel@ and dl@ both mask to d***l@
INSERT INTO auth.users(email) VALUES ('daniel@gmail.com'), ('dl@gmail.com');

-- ── POSITIVE CONTROL: case + whitespace variants of ONE address. ──
-- These ARE one normalized identity and MUST be reported, exactly once, with occurrences = 2.
-- The address also gets ONE auth user, so it is genuinely eligible — which makes it a second,
-- independent proof: TWO waitlist rows must contribute exactly ONE eligible person, never two.
INSERT INTO auth.users(email) VALUES ('navid@example.com');
INSERT INTO public.waitlist(email,status,invited_at) VALUES
  ('  Navid@Example.com ','invited', now() - interval '9 days'),
  ('navid@example.com','invited',   now() - interval '9 days');
SQL

echo "── 1. NEGATIVE CONTROL: mask collisions must NOT be reported as duplicates ──"
DUP=$("$PGBIN/psql" -U postgres -X -tA -F '|' -c "$(sed -n '/^SELECT$/,/^ORDER BY d.occurrences/p' supabase/audits/onboarding_resume_audit.sql)")
echo "$DUP" | sed 's/^/    /'
chk "arato/alberto NOT reported (masks collide, addresses differ)" "0" "$(printf '%s\n' "$DUP" | grep -c 'a\*\*\*o@tkogrp.com' || true)"
chk "daniel/dl NOT reported (masks collide, addresses differ)"     "0" "$(printf '%s\n' "$DUP" | grep -c 'd\*\*\*l@gmail.com' || true)"
chk "the colliding masks ARE genuinely identical (control is valid)" "t" \
  "$(q "SELECT left(split_part('arato@tkogrp.com','@',1),1)||'***'||right(split_part('arato@tkogrp.com','@',1),1)||'@'||split_part('arato@tkogrp.com','@',2)
        = left(split_part('alberto@tkogrp.com','@',1),1)||'***'||right(split_part('alberto@tkogrp.com','@',1),1)||'@'||split_part('alberto@tkogrp.com','@',2)")"

echo "── 2. POSITIVE CONTROL: case/whitespace variants ARE one duplicate ──"
chk "navid variants reported exactly once"      "1" "$(printf '%s\n' "$DUP" | grep -c 'n\*\*\*d@example.com' || true)"
chk "with occurrences = 2"                      "2" "$(printf '%s\n' "$DUP" | grep 'n\*\*\*d@example.com' | cut -d'|' -f4)"
chk "reported against the waitlist source"      "waitlist" "$(printf '%s\n' "$DUP" | grep 'n\*\*\*d@example.com' | cut -d'|' -f2)"
chk "total duplicate rows = 1 (only the real one)" "1" "$(printf '%s\n' "$DUP" | grep -c . || true)"
chk "no normalized address emitted"             "0" "$(printf '%s\n' "$DUP" | grep -cE 'navid@example|arato@tkogrp|daniel@gmail' || true)"

echo "── 3. THE OLD QUERY WOULD HAVE FAILED (the defect is real, not theoretical) ──"
OLD=$(q "SELECT count(*) FROM (
  SELECT left(split_part(lower(email),'@',1),1)||'***'||right(split_part(lower(email),'@',1),1)||'@'||split_part(lower(email),'@',2) AS m
  FROM auth.users WHERE email IS NOT NULL GROUP BY 1 HAVING count(*)>1) z")
chk "old mask-grouped auth query reports FALSE duplicates" "2" "$OLD"
chk "corrected auth query reports none"                    "0" \
  "$(q "SELECT count(*) FROM (SELECT lower(pg_catalog.btrim(email)) FROM auth.users WHERE email IS NOT NULL GROUP BY 1 HAVING count(*)>1) z")"

echo "── 4. NO JOIN MULTIPLICATION: an address with two auth users counts once ──"
"${PSQL[@]}" -c "INSERT INTO auth.users(email) VALUES ('twin@x.com'),('twin@x.com'); INSERT INTO public.waitlist(email,status,invited_at) VALUES ('twin@x.com','invited', now() - interval '5 days');" >/dev/null
COMBINED=$("$PGBIN/psql" -U postgres -X -tA -F '|' -c "$(sed -n '/^WITH$/,$p' supabase/audits/onboarding_resume_audit.sql)")
get(){ printf '%s\n' "$COMBINED" | grep -F "|$1|" | cut -d'|' -f3; }
chk "unique waitlist addresses = 4 (navid's 2 rows count once)" "4" "$(get 'waitlist addresses (unique, normalized)')"
chk "ambiguous address counted as UNSAFE"           "1" "$(get 'AMBIGUOUS: more than one auth user at the address')"
chk "ambiguous + invited isolated"                  "1" "$(get 'ambiguous AND on the waitlist as invited')"
chk "ambiguous EXCLUDED from eligibility"           "3" "$(get 'total eligible')"
chk "duplicate waitlist addresses detected"         "1" "$(get 'duplicate normalized addresses on the waitlist')"
chk "waitlist ROWS reported separately from addresses" "5" "$(get 'waitlist ROWS (inflated by duplicates)')"
chk "a duplicated waitlist address yields ONE eligible person" "3" "$(get 'total eligible')"

echo "── 5. eligibility is completion-based, not sign-in-based ──"
"${PSQL[@]}" -c "UPDATE auth.users SET last_sign_in_at = now() WHERE email='arato@tkogrp.com';" >/dev/null
C2=$("$PGBIN/psql" -U postgres -X -tA -F '|' -c "$(sed -n '/^WITH$/,$p' supabase/audits/onboarding_resume_audit.sql)")
g2(){ printf '%s\n' "$C2" | grep -F "|$1|" | cut -d'|' -f3; }
chk "signing in does NOT remove eligibility"        "3" "$(g2 'total eligible')"
chk "stuck cohort is visible"                       "1" "$(g2 'signed in but profile INCOMPLETE  <-- the stuck cohort')"
"${PSQL[@]}" -c "INSERT INTO public.profiles(id,email,profile_complete,updated_at) SELECT id,email,true,now() FROM auth.users WHERE email='arato@tkogrp.com';" >/dev/null
C3=$("$PGBIN/psql" -U postgres -X -tA -F '|' -c "$(sed -n '/^WITH$/,$p' supabase/audits/onboarding_resume_audit.sql)")
chk "completing the profile DOES remove eligibility" "2" "$(printf '%s\n' "$C3" | grep -F '|total eligible|' | cut -d'|' -f3)"
"${PSQL[@]}" -c "INSERT INTO public.invitation_deliveries(recipient_email,purpose,status) VALUES ('alberto@tkogrp.com','first_invite','bounced');" >/dev/null
C4=$("$PGBIN/psql" -U postgres -X -tA -F '|' -c "$(sed -n '/^WITH$/,$p' supabase/audits/onboarding_resume_audit.sql)")
chk "a bounced address is excluded from eligibility" "1" "$(printf '%s\n' "$C4" | grep -F '|total eligible|' | cut -d'|' -f3)"
chk "and counted as unsafe"                          "1" "$(printf '%s\n' "$C4" | grep -F '|suppressed at the provider (bounced/blocked/complained)|' | cut -d'|' -f3)"

echo
[ $fail -eq 0 ] && echo "ALL CHECKS PASSED" || { echo "FAILURES PRESENT"; exit 1; }
