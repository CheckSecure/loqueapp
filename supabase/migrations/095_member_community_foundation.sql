-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 095 — MEMBER COMMUNITY FOUNDATION (Andrel Next, Phase 2)
--
-- Establishes WHICH COMMUNITY a member belongs to, and the single authoritative predicate for
-- whether two communities may interact. It establishes nothing else: no path is rewired to call the
-- predicate here, so after this migration the boundary EXISTS but is NOT YET ENFORCED. Phase 3 wires
-- the relationship-creation paths through it. That distinction is deliberate and is stated again in
-- the function's own COMMENT, because a predicate nobody is required to call is a helper, not a
-- security boundary, and the Andrel codebase has been bitten before by protections believed to live
-- at a layer that never actually enforced them (migration 055 delegated meetings row-visibility to an
-- RLS configuration that existed in no migration file; the mutual-match emails were guarded by a
-- profile read that 058 had silently denied for ten days).
--
-- ─── WHY A COLUMN AND NOT A SECOND TABLE ──────────────────────────────────────────────────────
-- Every matching, discovery, messaging and admin path in this application already reads
-- public.profiles. A parallel `students` table would require duplicating can_discover_profile, the
-- public_profiles view, the canonical eligibility filter, the capacity RPCs, the credit-cycle
-- machinery and the whole introduction pipeline — and the duplicate would drift, exactly as the
-- as-built RLS policies drifted from git. One column makes segmentation expressible as a predicate
-- that every existing path can adopt in Phase 3 without forking.
--
-- ─── WHY THIS IS A NO-OP ON THE DAY IT IS APPLIED ─────────────────────────────────────────────
-- member_type is NOT NULL DEFAULT 'professional', so every existing row becomes 'professional' with
-- no backfill step and no window in which a row is uncommitted to a community. Every pair in the
-- database is therefore professional<->professional, for which community_pair_allowed returns TRUE.
-- The two mentorship flags default FALSE, so no professional is opted in to anything. Nothing reads
-- any of these columns yet. The migration is additive, idempotent, and behaviour-preserving.
--
-- ─── PRIVACY: NOTHING NEW BECOMES BROWSER-READABLE ────────────────────────────────────────────
-- Migration 058 revoked SELECT on public.profiles from PUBLIC/anon/authenticated and that is NOT
-- touched here. New columns on a table a role cannot read are not readable by that role. The
-- member-facing public_profiles view (057, amended 082) enumerates its columns explicitly, so it
-- does not acquire these by widening. No grant is added, changed, or restored anywhere in this file.
--
-- ─── DRIFT POSTURE ────────────────────────────────────────────────────────────────────────────
-- This project has documented schema drift between supabase/migrations and the live database
-- (docs/migrations/2026-05-11_conversations_rls_as_built.sql). This migration therefore ASSERTS its
-- own end state in a postcondition block rather than assuming its DDL had the intended effect, and
-- refuses (rolls back) if any object is not exactly as specified.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── SECTION 0 — PRECONDITIONS ────────────────────────────────────────────────────────────────
-- Fail before touching anything if the target is not what this migration was written against.
DO $precheck$
DECLARE
  v_type text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'profiles' AND c.relkind = 'r'
  ) THEN
    RAISE EXCEPTION '095 REFUSED: public.profiles is missing or is not an ordinary table.';
  END IF;

  -- If member_type already exists (a partial re-run, or drift), it must already be the right type.
  -- Silently coexisting with a differently-typed column is how a "safe" re-run corrupts a contract.
  SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) INTO v_type
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = 'public.profiles'::pg_catalog.regclass
    AND a.attname = 'member_type' AND a.attnum > 0 AND NOT a.attisdropped;

  IF v_type IS NOT NULL AND v_type <> 'text' THEN
    RAISE EXCEPTION '095 REFUSED: profiles.member_type already exists with type %, expected text.', v_type;
  END IF;
END
$precheck$;


-- ── SECTION 1 — COMMUNITY IDENTITY ───────────────────────────────────────────────────────────
--
-- text + CHECK rather than a Postgres enum, matching this repository's established practice
-- (issue_reports.status, member_pairs.source, batch_suggestions.status). An enum would need
-- ALTER TYPE ... ADD VALUE to grow, which cannot run inside a transaction block on older servers
-- and cannot be removed at all; a CHECK is alterable in one reviewable statement.
--
-- NOT NULL DEFAULT 'professional' is the load-bearing part: it makes "every existing member is a
-- professional" a property of the schema rather than of a backfill script that might half-run.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS member_type text NOT NULL DEFAULT 'professional';

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'profiles_member_type_check'
      AND conrelid = 'public.profiles'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_member_type_check
      CHECK (member_type IN ('professional', 'next'));
  END IF;
END
$constraint$;

COMMENT ON COLUMN public.profiles.member_type IS
  'Which Andrel community this member belongs to: ''professional'' (the existing network) or '
  '''next'' (Andrel Next). NOT NULL DEFAULT ''professional'' so every pre-existing member is a '
  'professional by construction. The authoritative pairing rule is public.community_pair_allowed(); '
  'never compare this column ad hoc at a call site.';


-- ── SECTION 2 — ANDREL NEXT PROFILE FOUNDATION ───────────────────────────────────────────────
--
-- Only the genuinely NEW signals. Everything else a student profile needs is served by existing
-- columns and is deliberately NOT duplicated here: school -> company, degree -> title,
-- practice areas -> expertise, goals -> purposes, interests -> interests,
-- industries -> intro_preferences, markets -> geographic_scope, plus location/seniority/role_type.
-- Reusing those is what lets Andrel Next inherit scoring, rarity weighting, exposure balancing,
-- capacity and the same-institution exclusion in Phase 3 with no new matching code.

-- Expected graduation year. The one student attribute with no existing analogue, and a real
-- matching signal (1L/2L/3L cohorts want materially different things). Nullable: a professional has
-- no graduation year, and a Next member may not have supplied one yet.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS grad_year smallint;

DO $gradyear$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'profiles_grad_year_check'
      AND conrelid = 'public.profiles'::pg_catalog.regclass
  ) THEN
    -- A range, not a free integer: it catches a mis-parsed form value (a two-digit year, a
    -- timestamp, a typo'd century) at the boundary rather than letting it into a matching signal.
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_grad_year_check
      CHECK (grad_year IS NULL OR (grad_year BETWEEN 1950 AND 2100));
  END IF;
END
$gradyear$;

-- The MENTOR side of the future Andrel Next bridge: a professional's explicit, opt-in consent to be
-- considered for student mentorship.
--
-- THIS IS DELIBERATELY NOT profiles.open_to_mentorship. That column already carries
-- WITHIN-PROFESSIONAL semantics: app/actions.ts derives it from mentorship_role
-- (Mentor/Mentee/Both), and lib/generate-recommendations.ts shouldFilterByMentorship() uses it to
-- decide whether juniors may see a senior and how mid-level candidates are distributed. Reusing it
-- would silently enrol every professional who ever selected "Mentor" into a student-facing
-- programme they never consented to. Two different consents need two different columns.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS open_to_next_mentorship boolean NOT NULL DEFAULT false;

-- The MENTEE side: a Next member asking to be matched with a mentor. Both sides must be true before
-- Phase 3's bridge may pair them, so a student who has not asked is never matched to a mentor.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS seeking_next_mentorship boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.grad_year IS
  'Expected graduation year for an Andrel Next member. NULL for professionals and for Next members '
  'who have not supplied one.';
COMMENT ON COLUMN public.profiles.open_to_next_mentorship IS
  'A professional''s explicit opt-in to be considered as a mentor for Andrel Next members. DEFAULT '
  'false: no existing member is opted in, and no professional''s experience changes until they act. '
  'DISTINCT FROM open_to_mentorship, which is derived from mentorship_role and governs '
  'within-professional seniority matching — see migration 095 and lib/generate-recommendations.ts.';
COMMENT ON COLUMN public.profiles.seeking_next_mentorship IS
  'An Andrel Next member''s request to be matched with a professional mentor. DEFAULT false. Phase 3''s '
  'mentorship bridge requires BOTH this and the mentor''s open_to_next_mentorship to be true.';


-- ── SECTION 3 — INDEX ────────────────────────────────────────────────────────────────────────
-- Partial, because 'next' is the rare value: the index stays near-empty while Andrel Next is small
-- and costs nothing on the professional path, while giving Phase 3's candidate-pool scoping and the
-- segmentation census a usable access path. No index is added for the mentorship flags: no query
-- reads them yet, and an index with no reader is speculative weight.
CREATE INDEX IF NOT EXISTS idx_profiles_member_type_next
  ON public.profiles (member_type)
  WHERE member_type <> 'professional';


-- ── SECTION 4 — THE AUTHORITATIVE COMMUNITY-PAIR PREDICATE ───────────────────────────────────
--
-- ONE statement of the base rule, so a future caller cannot re-derive a slightly different version
-- of it at a call site:
--
--     professional + professional -> TRUE
--     next + next                 -> TRUE
--     professional + next         -> FALSE   (either ordering)
--     anything unresolvable       -> FALSE
--
-- BASE RULE ONLY. The mentorship bridge is NOT modelled here and must never be added to this
-- function. Making cross-community pairing conditional inside the default predicate would mean the
-- boundary and its exception share one code path, so a bug in the exception silently widens the
-- default. Phase 3's bridge will be a separate, explicitly authorized path that a caller opts into,
-- leaving this function's answer to "may these two communities interact by default?" always FALSE
-- across communities.
--
-- ─── WHY SECURITY DEFINER ─────────────────────────────────────────────────────────────────────
-- It must read public.profiles.member_type, and migration 058 revoked SELECT on that table from
-- every browser role. As SECURITY INVOKER this function would return a permission error (or, worse,
-- a caller-dependent answer) for exactly the roles most likely to reach it. DEFINER makes the answer
-- deterministic and independent of who asks.
--
-- ─── WHY THAT IS NOT A NEW DISCOVERY MECHANISM ────────────────────────────────────────────────
-- SECURITY DEFINER + a readable table is how a helper becomes an oracle: any authenticated member
-- could otherwise enumerate UUIDs and learn which community each belongs to — a genuine, if narrow,
-- discovery channel that Andrel's privacy model does not otherwise offer. It is closed the same way
-- create_reciprocal_suggestion and supersede_other_resume_tokens close it: EXECUTE is REVOKED from
-- PUBLIC, anon and authenticated, and GRANTed only to service_role. A browser client cannot call
-- this function at all. It returns a bare boolean and never a profile field, so even a future caller
-- cannot use it to read profile data.
--
-- ─── FAIL CLOSED ──────────────────────────────────────────────────────────────────────────────
-- NULL input, a member with no profiles row (deleted or never created), a NULL or unrecognised
-- member_type, and a member paired with themselves all return FALSE. COALESCE guarantees the
-- function never returns NULL, so `IF NOT community_pair_allowed(...)` can never fall through a
-- three-valued-logic gap at a call site.
CREATE OR REPLACE FUNCTION public.community_pair_allowed(member_one uuid, member_two uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = ''
AS $$
  SELECT COALESCE(
    member_one IS NOT NULL
    AND member_two IS NOT NULL
    AND member_one <> member_two
    AND EXISTS (
      SELECT 1
      FROM public.profiles a, public.profiles b
      WHERE a.id = member_one
        AND b.id = member_two
        AND a.member_type IN ('professional', 'next')
        AND b.member_type IN ('professional', 'next')
        AND a.member_type = b.member_type
    ),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.community_pair_allowed(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.community_pair_allowed(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.community_pair_allowed(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.community_pair_allowed(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.community_pair_allowed(uuid, uuid) IS
  'THE base Professional/Next community rule: TRUE only when both members exist and share a '
  'member_type. Fails closed on NULL, missing, deleted, unrecognised, or self-paired members, and '
  'never returns NULL. Contains NO mentorship exception by design — the Andrel Next bridge is a '
  'separate authorized path, not a loosening of this predicate. service_role EXECUTE only, so it is '
  'not reachable from a browser and cannot be used to enumerate members. '
  'NOT YET ENFORCED: as of migration 095 no relationship-creation path calls this function; it '
  'becomes a security boundary only when Phase 3 wires those paths through it.';


-- ── SECTION 5 — POSTCONDITIONS ───────────────────────────────────────────────────────────────
-- Assert the end state rather than assume it. Every RAISE aborts the transaction and rolls the whole
-- migration back, so a partially-applied community foundation is not a reachable state.
DO $postcheck$
DECLARE
  v_notnull  boolean;
  v_default  text;
  v_bad      bigint;
  v_secdef   boolean;
  v_cfg      text;
  v_anon     boolean;
  v_auth     boolean;
  v_service  boolean;
  v_pub_sel  boolean;
BEGIN
  -- (a) member_type is NOT NULL, defaulted, constrained, and uniformly professional.
  SELECT a.attnotnull, pg_catalog.pg_get_expr(d.adbin, d.adrelid)
    INTO v_notnull, v_default
  FROM pg_catalog.pg_attribute a
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.profiles'::pg_catalog.regclass AND a.attname = 'member_type';

  IF NOT COALESCE(v_notnull, false) THEN
    RAISE EXCEPTION '095: profiles.member_type is not NOT NULL.';
  END IF;
  IF v_default IS NULL OR v_default NOT LIKE '%professional%' THEN
    RAISE EXCEPTION '095: profiles.member_type default is [%], expected ''professional''.', v_default;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'profiles_member_type_check'
      AND conrelid = 'public.profiles'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION '095: profiles_member_type_check is missing.';
  END IF;

  SELECT count(*) INTO v_bad FROM public.profiles
   WHERE member_type IS NULL OR member_type NOT IN ('professional', 'next');
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '095: % profiles row(s) hold an invalid member_type.', v_bad;
  END IF;

  -- (b) The mentorship flags exist and default to OFF. A TRUE default would opt the entire existing
  --     membership into a student-facing programme, which is the single worst outcome available here.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'public.profiles'::pg_catalog.regclass
      AND a.attname = 'open_to_next_mentorship'
      AND a.attnotnull
      AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) = 'false'
  ) THEN
    RAISE EXCEPTION '095: profiles.open_to_next_mentorship is not NOT NULL DEFAULT false.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'public.profiles'::pg_catalog.regclass
      AND a.attname = 'seeking_next_mentorship'
      AND a.attnotnull
      AND pg_catalog.pg_get_expr(d.adbin, d.adrelid) = 'false'
  ) THEN
    RAISE EXCEPTION '095: profiles.seeking_next_mentorship is not NOT NULL DEFAULT false.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE open_to_next_mentorship OR seeking_next_mentorship) THEN
    RAISE EXCEPTION '095: a member is already opted in to Next mentorship; expected none.';
  END IF;

  -- (c) The predicate is hardened and service-role-only.
  SELECT p.prosecdef, COALESCE(pg_catalog.array_to_string(p.proconfig, ','), '(none)')
    INTO v_secdef, v_cfg
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'community_pair_allowed'
    AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'member_one uuid, member_two uuid';

  IF v_secdef IS NULL THEN
    RAISE EXCEPTION '095: community_pair_allowed(uuid, uuid) was not created.';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION '095: community_pair_allowed is not SECURITY DEFINER.';
  END IF;
  IF v_cfg NOT IN ('search_path=', 'search_path=""') THEN
    RAISE EXCEPTION '095: community_pair_allowed has a mutable search_path (config: %).', v_cfg;
  END IF;

  v_anon    := pg_catalog.has_function_privilege('anon',          'public.community_pair_allowed(uuid, uuid)', 'EXECUTE');
  v_auth    := pg_catalog.has_function_privilege('authenticated', 'public.community_pair_allowed(uuid, uuid)', 'EXECUTE');
  v_service := pg_catalog.has_function_privilege('service_role',  'public.community_pair_allowed(uuid, uuid)', 'EXECUTE');
  IF v_anon OR v_auth THEN
    RAISE EXCEPTION '095: a browser role can EXECUTE community_pair_allowed (anon=%, authenticated=%).', v_anon, v_auth;
  END IF;
  IF NOT v_service THEN
    RAISE EXCEPTION '095: service_role cannot EXECUTE community_pair_allowed.';
  END IF;

  -- (d) THE PRIVACY INVARIANT. This migration must not have restored, widened, or accidentally
  --     re-granted browser SELECT on public.profiles. Asserted rather than assumed, because that is
  --     the exact contract (058) whose silent breakage caused the mutual-match email defect.
  v_pub_sel := pg_catalog.has_table_privilege('anon', 'public.profiles', 'SELECT')
            OR pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'SELECT');
  IF v_pub_sel THEN
    RAISE EXCEPTION '095: a browser role holds SELECT on public.profiles; migration 058''s contract is broken.';
  END IF;
  IF NOT pg_catalog.has_table_privilege('service_role', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION '095: service_role lost SELECT on public.profiles.';
  END IF;
END
$postcheck$;

COMMIT;
