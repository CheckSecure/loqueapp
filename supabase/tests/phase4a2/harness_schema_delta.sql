-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PHASE 4A-2 HARNESS — DELTA over supabase/tests/phase3/harness_schema.sql
--
-- Disposable. NEVER point this at production.
--
-- Phase 3's harness models what the six community-boundary functions touch. Migration 100 is about
-- the profiles INSERT path, which touches a different and larger surface: the unique constraints on
-- profiles, an auth identity, a waitlist invitation, and four other triggers that fire on the same
-- statement. This file adds exactly that, and nothing that would change a Phase 3 result.
--
-- IT IS A DELTA ON PURPOSE. Phase 3's fixtures insert five profiles with an explicit member_type
-- and no waitlist rows — every one of those inserts is REFUSED once migration 100 is loaded.
-- Extending phase3/ in place would have forced those fixtures to be rewritten, which is exactly the
-- weakening this split avoids. Phase 3 never loads migration 100; this harness never loads Phase 3's
-- fixtures.
--
-- ─── PARITY, AND WHERE IT STOPS ───────────────────────────────────────────────────────────────
-- Modelled from the tracked migrations and the production catalog facts recorded in the migration
-- 100 preflight:
--     profiles PRIMARY KEY (id)                     -- phase3 harness
--     profiles UNIQUE (email), plain btree           -- production; CASE-SENSITIVE
--     profiles.email NOT NULL                        -- production (attnotnull = true)
--     five non-internal triggers                     -- 053 / 075 / 084 / 099 loaded verbatim
--
-- NOT modelled, deliberately: RLS policies, PostgREST, the resume-token lifecycle, the credit
-- ledger beyond the enrolment trigger. None is reachable from a profiles INSERT.
--
-- LOCAL POSTGRESQL IS 16.x; PRODUCTION IS 17.6. The behaviours under test here — BEFORE INSERT
-- firing for ON CONFLICT, trigger name ordering, FOR SHARE, constraint evaluation on an excluded
-- row — are unchanged across those majors, but this harness cannot prove that by itself. Where a
-- property must be true of PRODUCTION, assert it in migration 100's own postapply block, which runs
-- against the real database. Same discipline as the phase3 README's ACL note.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ── profiles: the columns and constraints the real INSERT path depends on ────────────────────
-- Phase 3's harness has id/email/full_name/company/account_status/profile_complete/is_test_account/
-- is_admin/matching_paused/welcome_sent_at. Everything below is what 053, 084, 100 and the three
-- application writers actually touch.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS created_at              timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at              timestamptz          DEFAULT now(),
  ADD COLUMN IF NOT EXISTS location                text,
  ADD COLUMN IF NOT EXISTS onboarding_step         integer,
  ADD COLUMN IF NOT EXISTS password_reset_required boolean,
  ADD COLUMN IF NOT EXISTS email_verified          boolean,
  ADD COLUMN IF NOT EXISTS email_verified_at       timestamptz,
  ADD COLUMN IF NOT EXISTS verification_status     text,
  ADD COLUMN IF NOT EXISTS trust_score             integer,
  ADD COLUMN IF NOT EXISTS subscription_tier       text,
  ADD COLUMN IF NOT EXISTS is_founding_member      boolean DEFAULT false;

-- Production: email is NOT NULL and carries a PLAIN unique index — not lower(email), unlike
-- waitlist_email_lower_uniq (migration 009). The case sensitivity is load-bearing: it is why
-- step 0b moved completeOnboarding onto the primary key, and test 26 depends on the NOT NULL.
ALTER TABLE public.profiles ALTER COLUMN email SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conname = 'profiles_email_key'
                    AND conrelid = 'public.profiles'::pg_catalog.regclass) THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_email_key UNIQUE (email);
  END IF;
END $$;

-- ── auth.users ────────────────────────────────────────────────────────────────────────────────
-- lookup_auth_identity reads exactly these three columns. encrypted_password is included because
-- the production column is a non-NULL empty-string sentinel for passwordless invitees and a test
-- that assumed otherwise would be measuring the wrong thing; nothing here reads it.
CREATE TABLE IF NOT EXISTS auth.users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text,
  encrypted_password text NOT NULL DEFAULT '',
  invited_at         timestamptz,
  email_confirmed_at timestamptz,
  last_sign_in_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ── public.waitlist ───────────────────────────────────────────────────────────────────────────
-- No harness in this repository modelled waitlist before now.
--
-- status carries NO CHECK CONSTRAINT — verified against the tracked migrations, where none of
-- 001-099 constrains it. The vocabulary lives only in lib/referrals/statusTransitions.ts
-- (pending -> approved -> contacted -> invited, plus declined / revoked). Reproducing that absence
-- is deliberate: it is the whole reason may_provision_profile must test POSITIVELY for 'invited'
-- rather than negatively for 'not revoked'. A harness that added a CHECK would make case 27 pass
-- for the wrong reason.
--
-- waitlist_email_lower_uniq is migration 009's, and it normalises with lower() alone while 078's
-- resolvers use lower(btrim(...)). That gap is what migration 099's conflicting-intent trigger
-- exists to close, so the index is reproduced exactly as 009 declares it.
CREATE TABLE IF NOT EXISTS public.waitlist (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  text,
  full_name              text,
  status                 text,
  invited_at             timestamptz,
  revoked_at             timestamptz,
  reminder_enrollment_at timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email_lower_uniq ON public.waitlist (lower(email));

GRANT SELECT, INSERT, UPDATE ON public.waitlist TO service_role;
GRANT SELECT ON auth.users TO service_role;

-- Supabase grants service_role full table access; the Phase 3 harness reproduces the default
-- privileges for FUNCTIONS only. Without this, `SET ROLE service_role; INSERT INTO profiles …`
-- would fail on a missing GRANT and case 11 would report a pass for entirely the wrong reason —
-- it must be refused by the trigger, not by the ACL.
-- (membership_credit_cycles needs no grant: 053's enroll_membership_credit_cycle is SECURITY
-- DEFINER, so it writes as its owner whatever role fired the INSERT. It is also created by 053,
-- which loads after this file.)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO service_role;
