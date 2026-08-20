-- Disposable schema for verifying migration 063 against a REAL PostgreSQL.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- PARITY WITH PRODUCTION — RECONCILED AGAINST THE LIVE pg_catalog
--
-- Source of truth: the read-only catalog audit (supabase/audit/063_production_schema_audit.sql) run
-- against production PostgreSQL 17.6 on 2026-08-19. Every column type, nullability, default,
-- constraint, index (including partial predicates), trigger, RLS flag and grant below was compared
-- field by field against that result, by running the SAME audit against this fixture and diffing the
-- two JSON documents. Earlier drafts were reconciled against PostgREST's OpenAPI and the repository
-- migrations; both are blind to indexes, CHECK constraints, triggers, RLS and grants, and the
-- catalog comparison found real differences in all of those categories.
--
-- TRIGGERS — THE HEADLINE RESULT. Production has ZERO non-internal triggers on intro_requests,
-- recommendation_batches, member_pairs, matches and blocked_users. Every trigger on those tables is
-- an internal RI constraint trigger belonging to a foreign key. The single non-internal trigger on
-- any audited table is trg_enroll_membership_credit_cycle, AFTER INSERT ON public.profiles, which
-- migration 063 cannot fire because it never inserts a profile. No production-only trigger changes
-- what migration 063 does.
--
-- RLS IS ENABLED HERE, exactly as production has it (relrowsecurity = true, relforcerowsecurity =
-- false on all six). POLICIES ARE DELIBERATELY OMITTED, and that omission is sound rather than
-- convenient: because RLS is NOT forced, the table OWNER bypasses it entirely, and the capacity RPCs
-- are SECURITY DEFINER owned by postgres, which owns these tables. Row policies therefore never
-- apply to any statement migration 063 executes. Reproducing them would also require auth.uid() and
-- is_admin() stubs whose behaviour would be invented, not observed. What DOES matter — that anon and
-- authenticated cannot EXECUTE the functions — is asserted from pg_proc in the concurrency script.
--
-- GRANTS ARE REPRODUCED EXACTLY, including the broad ones. Production grants anon and authenticated
-- full arwdDxtm on recommendation_batches and blocked_users, and SELECT/TRUNCATE on intro_requests.
-- Those are Supabase platform defaults, not anything a repo migration created. They are copied here
-- so the fixture cannot look safer than production does. See the note at the end of this file.
--
-- KNOWN, DELIBERATE DEVIATIONS — each stated rather than silently absorbed:
--   • profiles.id defaults to gen_random_uuid() here, extensions.uuid_generate_v4() in production.
--     Equivalent generators; migration 063 never inserts a profile, so nothing observes it.
--   • Columns of profiles/matches that migration 063 never reads are omitted, along with the CHECK
--     constraints that govern only those columns. Every column the RPCs touch is present with
--     production's exact type, nullability and default.
--   • auth.users is created as a minimal stub, because production's blocked_users foreign keys point
--     at auth.users(id) rather than at profiles.
--   • Performance-only indexes on non-audited access paths are included where cheap; every UNIQUE
--     and every PARTIAL index is reproduced, because those change write behaviour.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role  NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon          NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;

DROP TABLE IF EXISTS public.intro_requests, public.recommendation_batches, public.member_pairs,
                     public.matches, public.blocked_users, public.profiles CASCADE;
DROP TABLE IF EXISTS auth.users CASCADE;
CREATE SCHEMA IF NOT EXISTS auth;

-- ── auth.users (minimal stub) ───────────────────────────────────────────────────────────────────
-- Production's blocked_users foreign keys reference auth.users(id), not profiles(id). Only the
-- column the FKs need is reproduced.
CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

-- ── profiles ────────────────────────────────────────────────────────────────────────────────────
-- Only the columns the capacity RPCs read, plus the NOT NULL ones an INSERT must satisfy, plus
-- `location` because profiles_complete_requires_location_chk depends on it.
-- NULLABILITY MATTERS: production leaves account_status, profile_complete and is_admin NULLABLE
-- with defaults, so a NULL account_status yields NULL (not true) in the eligibility predicate and
-- the member is correctly ineligible. Making them NOT NULL here would make that case untestable.
CREATE TABLE public.profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL,
  location              text,
  account_status        text DEFAULT 'active',            -- nullable in production
  profile_complete      boolean DEFAULT false,            -- nullable in production
  is_admin              boolean DEFAULT false,            -- nullable in production
  is_test_account       boolean NOT NULL DEFAULT false,
  matching_paused       boolean NOT NULL DEFAULT false,
  open_to_roles         boolean NOT NULL DEFAULT false,
  recruiter             boolean NOT NULL DEFAULT false,
  opp_delivered_count   integer NOT NULL DEFAULT 0,
  email_notifications_enabled boolean NOT NULL DEFAULT true,
  desired_connections   jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_focus_areas   jsonb NOT NULL DEFAULT '[]'::jsonb,
  show_activity_status  boolean NOT NULL DEFAULT true,
  created_at            timestamptz DEFAULT now(),
  updated_at            timestamptz DEFAULT now(),
  CONSTRAINT profiles_email_key UNIQUE (email),
  CONSTRAINT profiles_account_status_check
    CHECK (account_status = ANY (ARRAY['active'::text, 'deactivated'::text, 'flagged'::text])),
  -- Migration 061. MATERIAL: an earlier fixture seeded profile_complete = true with no location,
  -- which production would have REJECTED. The seed below now supplies a location.
  CONSTRAINT profiles_complete_requires_location_chk
    CHECK (profile_complete IS NOT TRUE
           OR location IS NOT NULL AND btrim(location, E' \t\n\r') <> ''::text)
);

-- ── member_pairs (migration 050) ────────────────────────────────────────────────────────────────
CREATE TABLE public.member_pairs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id             uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_b_id             uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  source                text NOT NULL DEFAULT 'reciprocal',
  status                text NOT NULL DEFAULT 'active',
  recommend_count       integer NOT NULL DEFAULT 0,
  first_recommended_at  timestamptz,
  last_recommended_at   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- REQUIRED by create_reciprocal_suggestion's ON CONFLICT (user_a_id, user_b_id).
  CONSTRAINT member_pairs_unique UNIQUE (user_a_id, user_b_id),
  -- MATERIAL. The RPC inserts (LEAST, GREATEST); production ENFORCES that ordering and would raise
  -- 23514 if it ever did otherwise. Without this the fixture would accept a reversed pair silently.
  CONSTRAINT member_pairs_canonical_ck CHECK (user_a_id < user_b_id),
  -- MATERIAL. p_source flows straight into this column, so a caller passing an unlisted source
  -- (for example 'admin_reciprocal') FAILS in production and would have passed here.
  CONSTRAINT member_pairs_source_check
    CHECK (source = ANY (ARRAY['reciprocal'::text,'onboarding'::text,'weekly'::text,
                               'admin'::text,'backfill'::text])),
  CONSTRAINT member_pairs_status_check
    CHECK (status = ANY (ARRAY['active'::text,'expired'::text,'passed'::text,'matched'::text,
                               'blocked'::text,'ineligible'::text,'superseded'::text]))
);

-- ── matches ─────────────────────────────────────────────────────────────────────────────────────
-- Production leaves user_a_id / user_b_id NULLABLE and carries THREE uniqueness rules, including a
-- partial functional one on (LEAST, GREATEST). All are reproduced: they change INSERT behaviour.
CREATE TABLE public.matches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id             uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  user_b_id             uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  status                text DEFAULT 'active',
  matched_at            timestamptz DEFAULT now(),
  accepted_at           timestamptz,
  expires_at            timestamptz,
  created_at            timestamptz DEFAULT now(),
  admin_facilitated     boolean DEFAULT false,
  removed_at            timestamptz,
  is_opportunity_initiated boolean NOT NULL DEFAULT false,
  CONSTRAINT matches_user_a_id_user_b_id_key UNIQUE (user_a_id, user_b_id),
  CONSTRAINT matches_users_unique            UNIQUE (user_a_id, user_b_id)
);
CREATE UNIQUE INDEX matches_pair_uniq
  ON public.matches (LEAST(user_a_id, user_b_id), GREATEST(user_a_id, user_b_id))
  WHERE status <> 'removed'::text;
CREATE INDEX idx_matches_removed_at ON public.matches (removed_at) WHERE removed_at IS NOT NULL;

-- ── blocked_users ───────────────────────────────────────────────────────────────────────────────
-- Production uses a SURROGATE id primary key, a self-block CHECK, a UNIQUE pair, and foreign keys
-- to auth.users — not a composite PK and not profiles.
CREATE TABLE public.blocked_users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blocked_users_check CHECK (user_id <> blocked_user_id),
  CONSTRAINT blocked_users_user_id_blocked_user_id_key UNIQUE (user_id, blocked_user_id)
);
CREATE INDEX idx_blocked_users_user_id         ON public.blocked_users (user_id);
CREATE INDEX idx_blocked_users_blocked_user_id ON public.blocked_users (blocked_user_id);

-- ── recommendation_batches (migration 020) ──────────────────────────────────────────────────────
CREATE TABLE public.recommendation_batches (
  batch_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id             uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  batch_source          text NOT NULL CHECK (batch_source IN ('onboarding','weekly','admin_reciprocal','migration')),
  state                 text NOT NULL CHECK (state IN ('active','queued','completed','discarded')),
  reciprocal_batch_id   uuid,                              -- no FK in production
  created_at            timestamptz NOT NULL DEFAULT now(),
  generated_at          timestamptz NOT NULL DEFAULT now(),
  displayed_at          timestamptz,
  completed_at          timestamptz
);
-- THE active-window invariant, enforced by the database. Migration 063 must never need these
-- weakened, so they are created exactly as production has them.
CREATE UNIQUE INDEX recommendation_batches_one_active_per_member
  ON public.recommendation_batches (member_id) WHERE state = 'active';
CREATE UNIQUE INDEX recommendation_batches_one_queued_per_member
  ON public.recommendation_batches (member_id) WHERE state = 'queued';
CREATE INDEX recommendation_batches_member_state_idx ON public.recommendation_batches (member_id, state);
CREATE INDEX recommendation_batches_source_idx       ON public.recommendation_batches (batch_source);
CREATE INDEX recommendation_batches_reciprocal_idx   ON public.recommendation_batches (reciprocal_batch_id);

-- ── intro_requests ──────────────────────────────────────────────────────────────────────────────
-- status DEFAULTS TO 'pending' and carries NO CHECK constraint in production: statuses are
-- app-controlled. An earlier fixture added one "to be strict"; that made the fixture diverge from
-- production, so it has been removed. Migration 063 only ever writes 'suggested', 'queued' and
-- 'archived', and the test suite asserts that directly.
-- The requester/target foreign keys have NO cascade in production; pair_id cascades to SET NULL.
CREATE TABLE public.intro_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id          uuid NOT NULL REFERENCES public.profiles(id),
  target_user_id        uuid NOT NULL REFERENCES public.profiles(id),
  status                text NOT NULL DEFAULT 'pending',
  note                  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  reviewed_by           uuid REFERENCES public.profiles(id),
  reviewed_at           timestamptz,
  match_score           integer DEFAULT 0,
  batch_id              uuid,                              -- no FK in production
  credit_charged        boolean DEFAULT false,
  credit_hold           boolean DEFAULT false,
  match_reason          text,
  is_admin_initiated    boolean DEFAULT false,
  admin_notes           text,
  expired_at            timestamptz,
  pair_id               uuid REFERENCES public.member_pairs(id) ON DELETE SET NULL,
  resolution_reason     text,
  -- Migration 062.
  CONSTRAINT intro_requests_resolution_reason_check CHECK (
    resolution_reason IS NULL OR resolution_reason IN ('not_for_me','never_show','already_know')
  )
);
CREATE INDEX intro_requests_requester_status_batch_idx
  ON public.intro_requests (requester_id, status, batch_id);
CREATE INDEX idx_intro_requests_requester ON public.intro_requests (requester_id);
CREATE INDEX idx_intro_requests_target    ON public.intro_requests (target_user_id);
CREATE INDEX idx_intro_requests_status    ON public.intro_requests (status);
CREATE INDEX intro_requests_pair_id_idx   ON public.intro_requests (pair_id);
CREATE INDEX idx_intro_requests_admin_pending
  ON public.intro_requests (status) WHERE status = 'admin_pending'::text;
CREATE INDEX intro_requests_resolution_reason_idx
  ON public.intro_requests (resolution_reason) WHERE resolution_reason IS NOT NULL;

-- ── RLS, exactly as production has it: enabled everywhere, forced nowhere ───────────────────────
-- Not forced means the OWNER bypasses RLS, and the SECURITY DEFINER capacity RPCs run as the owner.
-- Policies are therefore never consulted for anything migration 063 does. See the header.
ALTER TABLE public.profiles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_pairs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocked_users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recommendation_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.intro_requests         ENABLE ROW LEVEL SECURITY;

-- ── GRANTS, copied verbatim from the production catalog ─────────────────────────────────────────
-- Reproduced so the fixture cannot look SAFER than production. Note what this says: anon and
-- authenticated hold FULL DML on recommendation_batches and blocked_users, and those tables have
-- ZERO RLS policies — which is what actually denies access, since RLS with no policy denies all
-- non-owner rows. On intro_requests the write privileges were revoked by migration 055, so that
-- table is protected by BOTH layers. This is flagged, not fixed, here: privilege remediation is
-- deliberately kept out of migration 063.
GRANT SELECT, REFERENCES, TRIGGER, TRUNCATE      ON public.intro_requests         TO anon, authenticated;
GRANT ALL                                        ON public.intro_requests         TO service_role;
GRANT ALL                                        ON public.recommendation_batches TO anon, authenticated, service_role;
GRANT ALL                                        ON public.blocked_users          TO anon, authenticated, service_role;
GRANT ALL                                        ON public.member_pairs           TO service_role;
GRANT SELECT, REFERENCES, TRIGGER, TRUNCATE      ON public.matches                TO anon, authenticated;
GRANT ALL                                        ON public.matches                TO service_role;
GRANT DELETE, REFERENCES, TRIGGER, TRUNCATE      ON public.profiles               TO anon, authenticated;
GRANT ALL                                        ON public.profiles               TO service_role;

-- Deterministic member ids so the scenarios can address them by name.
--   A,B  = the two sides of a reciprocal pair            C..H = counterparts / batch targets
--   X    = INELIGIBLE (matching_paused), used to prove eligibility is re-checked inside the RPC
-- Every profile carries a location, because profiles_complete_requires_location_chk demands one
-- whenever profile_complete is true.
INSERT INTO auth.users (id) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001'),('bbbbbbbb-0000-4000-8000-000000000002'),
  ('cccccccc-0000-4000-8000-000000000003'),('dddddddd-0000-4000-8000-000000000004'),
  ('eeeeeeee-0000-4000-8000-000000000005'),('ffffffff-0000-4000-8000-000000000006'),
  ('99999999-0000-4000-8000-000000000007'),('88888888-0000-4000-8000-000000000008'),
  ('77777777-0000-4000-8000-000000000009');

INSERT INTO public.profiles (id, email, profile_complete, location) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a@example.test', true, 'New York, NY'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b@example.test', true, 'New York, NY'),
  ('cccccccc-0000-4000-8000-000000000003', 'c@example.test', true, 'Boston, MA'),
  ('dddddddd-0000-4000-8000-000000000004', 'd@example.test', true, 'Boston, MA'),
  ('eeeeeeee-0000-4000-8000-000000000005', 'e@example.test', true, 'Chicago, IL'),
  ('ffffffff-0000-4000-8000-000000000006', 'f@example.test', true, 'Chicago, IL'),
  ('99999999-0000-4000-8000-000000000007', 'g@example.test', true, 'Austin, TX'),
  ('88888888-0000-4000-8000-000000000008', 'h@example.test', true, 'Austin, TX');
INSERT INTO public.profiles (id, email, profile_complete, location, matching_paused) VALUES
  ('77777777-0000-4000-8000-000000000009', 'x@example.test', true, 'Denver, CO', true);

-- A tiny assertion helper so each scenario reads as one line.
CREATE OR REPLACE FUNCTION public.t_assert(label text, got anyelement, want anyelement)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'FAIL % — got %, want %', label, got, want;
  END IF;
  RAISE NOTICE 'PASS %', label;
END $$;

-- Reset helper between scenarios. Order respects the intro_requests.pair_id foreign key.
CREATE OR REPLACE FUNCTION public.t_reset() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.intro_requests;
  DELETE FROM public.recommendation_batches;
  DELETE FROM public.member_pairs;
  DELETE FROM public.matches;
  DELETE FROM public.blocked_users;
END $$;
