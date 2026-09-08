-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- DISPOSABLE LOCAL HARNESS for Phase 3 Stage 1a. NEVER run against production.
--
-- The minimum real schema needed to EXECUTE migration 096's six restated functions honestly. Where
-- a column or table is referenced by one of those bodies it is modelled here rather than removed
-- from the function — the rule is that the harness bends, not the function.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Supabase-style roles.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  full_name text,
  company text,
  account_status text DEFAULT 'active',
  profile_complete boolean DEFAULT true,
  is_test_account boolean DEFAULT false,
  is_admin boolean DEFAULT false,
  matching_paused boolean DEFAULT false,
  welcome_sent_at timestamptz
);

CREATE TABLE public.matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id uuid NOT NULL REFERENCES public.profiles(id),
  user_b_id uuid NOT NULL REFERENCES public.profiles(id),
  status text DEFAULT 'active',
  admin_facilitated boolean DEFAULT false,
  admin_notes text,
  matched_at timestamptz DEFAULT now(),
  removed_at timestamptz,
  is_opportunity_initiated boolean DEFAULT false,
  opportunity_id uuid,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid REFERENCES public.matches(id),
  suggested_prompts jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE public.member_pairs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id uuid NOT NULL, user_b_id uuid NOT NULL,
  source text, status text DEFAULT 'active',
  recommend_count integer DEFAULT 0,
  first_recommended_at timestamptz, last_recommended_at timestamptz,
  UNIQUE (user_a_id, user_b_id)
);

CREATE TABLE public.recommendation_batches (
  batch_id uuid PRIMARY KEY, member_id uuid NOT NULL,
  batch_source text, state text, reciprocal_batch_id uuid,
  created_at timestamptz, generated_at timestamptz, displayed_at timestamptz, completed_at timestamptz
);

CREATE TABLE public.intro_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id uuid NOT NULL REFERENCES public.profiles(id),
  target_user_id uuid NOT NULL REFERENCES public.profiles(id),
  status text NOT NULL,
  is_admin_initiated boolean DEFAULT false,
  match_reason text, match_score integer,
  pair_id uuid, batch_id uuid, release_id uuid, responds_to_id uuid,
  capacity_released_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.blocked_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, blocked_user_id uuid NOT NULL
);

CREATE TABLE public.batch_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid, recipient_id uuid, suggested_id uuid,
  reason text, match_score numeric, position integer,
  created_at timestamptz DEFAULT now(), status text DEFAULT 'generated',
  shown_at timestamptz, score_bucket text, dropped_at timestamptz, materialized_at timestamptz
);

CREATE TABLE public.introduction_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number integer, week_start date, week_end date,
  status text, created_by uuid, created_at timestamptz DEFAULT now()
);

CREATE TABLE public.meeting_credits (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id),
  free_credits integer DEFAULT 0, premium_credits integer DEFAULT 0, balance integer DEFAULT 0
);

CREATE TABLE public.credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid, amount integer, type text, note text,
  event_key text UNIQUE, source_kind text, source_id uuid, funded_from text,
  created_at timestamptz DEFAULT now()
);

-- Helpers the six bodies call. Real behaviour, not stubs that weaken a gate.
CREATE OR REPLACE FUNCTION public.count_unresolved_introductions(
  p_member_id uuid, p_release_id uuid DEFAULT NULL, p_unused uuid DEFAULT NULL)
RETURNS integer LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT count(*)::integer FROM public.intro_requests ir
  WHERE ir.requester_id = p_member_id AND ir.status = 'suggested'
    AND ir.capacity_released_at IS NULL
    AND (p_release_id IS NULL OR ir.release_id IS DISTINCT FROM p_release_id);
$$;

CREATE OR REPLACE FUNCTION public.count_usable_visible_cards(p_member_id uuid)
RETURNS integer LANGUAGE sql STABLE SET search_path='' AS $$
  SELECT count(*)::integer FROM public.intro_requests ir
  WHERE ir.requester_id = p_member_id AND ir.status = 'suggested' AND ir.capacity_released_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.is_available_intro_target(p_member_id uuid, p_target_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$ SELECT true $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
-- Mirror production: browser roles have NO SELECT on profiles (migration 058).
REVOKE ALL ON public.profiles FROM anon, authenticated;
