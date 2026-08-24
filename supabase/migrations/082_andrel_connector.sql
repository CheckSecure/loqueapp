-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 082  ANDREL CONNECTOR — a manually awarded, discretionary recognition
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- WHAT IT IS. An administrator marks a member as an Andrel Connector: recognition for thoughtfully
-- expanding the community. It is NOT computed, NOT a threshold, NOT a ranking, and no referral or
-- nomination count is stored here. Nothing in this migration reads referral data at all.
--
-- ─── WHY THE MUTATION LIVES IN SQL ────────────────────────────────────────────────────────────
-- Three columns must agree (flag, timestamp, awarding admin) and one audit row must be written
-- exactly once. Doing that from TypeScript means four statements and four ways to end up with a
-- badge whose timestamp is NULL, or an audit trail missing an entry because the process died between
-- writes. set_andrel_connector() does all of it in ONE transaction, so the consistency is structural
-- rather than hoped for. It is also where "the acting admin is really an admin" is decided, under
-- service_role, where a browser cannot reach it.
--
-- ─── PRIVACY ──────────────────────────────────────────────────────────────────────────────────
-- Only the BOOLEAN is added to the public_profiles allowlist. awarded_at and awarded_by are NOT,
-- and the internal reason lives only in the audit table, which no browser role can read at all.
-- Because public_profiles is already row-constrained by can_discover_profile(), a member who cannot
-- see a profile cannot learn that it carries the badge — the row is simply not there. That property
-- is inherited, not re-implemented.
--
-- ─── WHAT THIS MIGRATION DOES NOT DO ──────────────────────────────────────────────────────────
-- No backfill and no automatic awarding. Every existing member is unbadged on apply: the column
-- defaults to false and nothing writes it. Migrations 063-081 are untouched, and 082 replaces no
-- existing function — public_profiles is the only existing object it redefines, and only to append
-- one column to its allowlist.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. PRE-FLIGHT ASSERTIONS — fail closed before anything is created ─────────────────────────
DO $guard$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      RAISE EXCEPTION '082: role % does not exist; this is not the audited environment.', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('public.public_profiles') IS NULL THEN
    RAISE EXCEPTION '082: public.public_profiles is absent; refusing to redefine the privacy contract.';
  END IF;
  IF pg_catalog.to_regprocedure('public.can_discover_profile(uuid)') IS NULL THEN
    RAISE EXCEPTION '082: can_discover_profile(uuid) is absent; the discovery predicate is missing.';
  END IF;

  -- The admin check inside set_andrel_connector() reads profiles.is_admin. If that column is not
  -- there the function would be unenforceable, so refuse rather than ship an open door.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                  WHERE attrelid = 'public.profiles'::pg_catalog.regclass
                    AND attname = 'is_admin' AND NOT attisdropped) THEN
    RAISE EXCEPTION '082: profiles.is_admin is absent; the administrator check cannot be enforced.';
  END IF;

  -- Already applied? Refuse rather than replace.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
              WHERE attrelid = 'public.profiles'::pg_catalog.regclass
                AND attname = 'is_andrel_connector' AND NOT attisdropped) THEN
    RAISE EXCEPTION '082: profiles.is_andrel_connector already exists; 082 appears to be applied.';
  END IF;
END;
$guard$;

-- ── 2. COLUMNS ────────────────────────────────────────────────────────────────────────────────
-- NOT NULL DEFAULT false is a metadata-only change on PostgreSQL 11+ (fast default): no table
-- rewrite, no row touched, and every existing member is unbadged by construction.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_andrel_connector        boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS andrel_connector_awarded_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS andrel_connector_awarded_by uuid        NULL;

COMMENT ON COLUMN public.profiles.is_andrel_connector IS
  'Andrel Connector recognition. Manually awarded by an administrator only - never computed, never '
  'backfilled, never derived from referral or nomination counts. The ONLY one of the three columns '
  'exposed to members (via public_profiles). See migration 082.';
COMMENT ON COLUMN public.profiles.andrel_connector_awarded_at IS
  'When the current recognition was awarded. Cleared on removal; the history survives in '
  'member_recognition_events. Never exposed to members.';
COMMENT ON COLUMN public.profiles.andrel_connector_awarded_by IS
  'The administrator who awarded the current recognition. PRIVATE - never exposed to members, never '
  'accepted from a browser. Cleared on removal; the history survives in member_recognition_events.';

-- INTERNAL CONSISTENCY, enforced rather than trusted. Badged means all three are set; unbadged means
-- the other two are NULL. There is no third state to reason about anywhere else in the codebase.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_andrel_connector_consistent_chk;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_andrel_connector_consistent_chk CHECK (
    (is_andrel_connector = false
       AND andrel_connector_awarded_at IS NULL
       AND andrel_connector_awarded_by IS NULL)
    OR
    (is_andrel_connector = true
       AND andrel_connector_awarded_at IS NOT NULL
       AND andrel_connector_awarded_by IS NOT NULL)
  );

-- Partial index: the only query shape is "who currently holds it", for a small set.
CREATE INDEX IF NOT EXISTS profiles_andrel_connector_idx
  ON public.profiles (id) WHERE is_andrel_connector = true;

-- ── 3. APPEND-ONLY AUDIT ──────────────────────────────────────────────────────────────────────
-- Same construction as account_deletion_events (migration 075): row AND statement triggers refuse
-- UPDATE/DELETE/TRUNCATE, RLS is on with ZERO policies, and every verb is revoked from every role
-- before the two the writer needs are granted back.
CREATE TABLE IF NOT EXISTS public.member_recognition_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id    uuid NOT NULL,
  recognition  text NOT NULL DEFAULT 'andrel_connector'
                 CHECK (recognition IN ('andrel_connector')),
  action       text NOT NULL CHECK (action IN ('awarded','removed')),
  admin_id     uuid NOT NULL,
  -- INTERNAL ONLY. Never rendered to any member, never logged, never returned by a member-facing
  -- read. Bounded so an operator cannot paste an unbounded blob into an append-only table that can
  -- never be edited or pruned afterwards.
  reason       text NULL CHECK (reason IS NULL OR pg_catalog.length(reason) <= 500),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS member_recognition_events_member_idx
  ON public.member_recognition_events (member_id, created_at DESC);

COMMENT ON TABLE public.member_recognition_events IS
  'Append-only history of manually awarded member recognitions (Andrel Connector). One row per '
  'award or removal, written in the same transaction as the profile change so it cannot be missed '
  'or duplicated. Holds NO referral counts and no private referral detail. service_role INSERT/SELECT '
  'only; unreachable from any browser role. See migration 082.';
COMMENT ON COLUMN public.member_recognition_events.reason IS
  'Optional internal note from the awarding administrator. NEVER exposed to members or to any '
  'member-facing payload.';

CREATE OR REPLACE FUNCTION public.tg_member_recognition_events_append_only()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $tg$
BEGIN
  RAISE EXCEPTION
    'public.member_recognition_events is append-only: % is not permitted', TG_OP;
  RETURN NULL;
END;
$tg$;
REVOKE ALL ON FUNCTION public.tg_member_recognition_events_append_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS member_recognition_events_append_only ON public.member_recognition_events;
CREATE TRIGGER member_recognition_events_append_only
  BEFORE UPDATE OR DELETE ON public.member_recognition_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_member_recognition_events_append_only();

DROP TRIGGER IF EXISTS member_recognition_events_append_only_stmt ON public.member_recognition_events;
CREATE TRIGGER member_recognition_events_append_only_stmt
  BEFORE TRUNCATE ON public.member_recognition_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_member_recognition_events_append_only();

ALTER TABLE public.member_recognition_events ENABLE ROW LEVEL SECURITY;

-- A GRANT IS ADDITIVE; ONLY REVOKE REMOVES. Supabase's ALTER DEFAULT PRIVILEGES hands every newly
-- created table to anon/authenticated/service_role with ALL, so granting only what we want would
-- leave everything we do not want in place. REVOKE ALL first is the only correct shape.
REVOKE ALL ON public.member_recognition_events FROM PUBLIC;
REVOKE ALL ON public.member_recognition_events FROM anon;
REVOKE ALL ON public.member_recognition_events FROM authenticated;
REVOKE ALL ON public.member_recognition_events FROM service_role;
GRANT SELECT, INSERT ON public.member_recognition_events TO service_role;

-- ── 4. THE ONLY WRITER ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_andrel_connector(
  p_member_id uuid,
  p_admin_id  uuid,
  p_enabled   boolean,
  p_reason    text DEFAULT NULL
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_now     timestamptz := pg_catalog.now();
  v_current boolean;
  v_reason  text;
  v_n       integer;
BEGIN
  IF p_member_id IS NULL OR p_admin_id IS NULL OR p_enabled IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','missing_argument');
  END IF;

  -- THE ADMINISTRATOR CHECK. p_admin_id is server-derived from the authenticated session by the
  -- caller and is re-verified here, so a forged value cannot award anything even if the TypeScript
  -- guard were bypassed. An admin cannot award to themselves either — recognition is for members.
  IF NOT EXISTS (SELECT 1 FROM public.profiles a
                  WHERE a.id = p_admin_id AND a.is_admin IS TRUE) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','forbidden','detail','not_an_administrator');
  END IF;
  IF p_admin_id = p_member_id THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','self_award');
  END IF;

  -- Trim, treat blank as absent, and REFUSE an oversized note rather than silently truncating it —
  -- a truncated internal note is worse than none, because it reads as complete.
  v_reason := NULLIF(pg_catalog.btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NOT NULL AND pg_catalog.length(v_reason) > 500 THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','reason_too_long');
  END IF;

  -- Lock the member row so two concurrent clicks serialise and cannot both write an audit entry.
  SELECT p.is_andrel_connector INTO v_current
    FROM public.profiles p WHERE p.id = p_member_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','member_not_found');
  END IF;

  -- IDEMPOTENT. Already in the requested state -> no write, and NO audit row. This is what makes a
  -- double submission harmless: the second call changes nothing and records nothing.
  IF v_current = p_enabled THEN
    RETURN pg_catalog.jsonb_build_object('outcome','unchanged','enabled', v_current);
  END IF;

  IF p_enabled THEN
    UPDATE public.profiles
       SET is_andrel_connector = true,
           andrel_connector_awarded_at = v_now,
           andrel_connector_awarded_by = p_admin_id
     WHERE id = p_member_id AND is_andrel_connector = false;
  ELSE
    -- Removal clears the active fields; the history is NOT lost, it moves to the audit table.
    UPDATE public.profiles
       SET is_andrel_connector = false,
           andrel_connector_awarded_at = NULL,
           andrel_connector_awarded_by = NULL
     WHERE id = p_member_id AND is_andrel_connector = true;
  END IF;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    -- Lost a race after the lock was released by a concurrent transaction; write nothing.
    RETURN pg_catalog.jsonb_build_object('outcome','unchanged','detail','raced');
  END IF;

  INSERT INTO public.member_recognition_events (member_id, recognition, action, admin_id, reason)
  VALUES (p_member_id, 'andrel_connector',
          CASE WHEN p_enabled THEN 'awarded' ELSE 'removed' END,
          p_admin_id, v_reason);

  RETURN pg_catalog.jsonb_build_object(
    'outcome', CASE WHEN p_enabled THEN 'awarded' ELSE 'removed' END,
    'enabled', p_enabled,
    'awarded_at', CASE WHEN p_enabled THEN v_now ELSE NULL END);
END;
$fn$;

REVOKE ALL ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) FROM anon;
REVOKE ALL ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) TO service_role;

COMMENT ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) IS
  'THE only writer of the Andrel Connector recognition. Verifies the acting administrator, locks the '
  'member row, keeps the three profile columns consistent, and appends exactly one audit event - all '
  'in one transaction. Idempotent: a repeat call in the same state writes nothing at all. '
  'service_role only.';

-- ── 5. THE MEMBER-FACING ALLOWLIST ────────────────────────────────────────────────────────────
-- This is the only part of 082 that touches an object that already exists, and that object is the
-- privacy contract itself. It is therefore the part that gets the most scrutiny.
--
-- WHY A MARKER CHECK IS NOT ENOUGH. "It is still a security_barrier view" would pass on a view whose
-- WHERE clause had been loosened, whose column list had gained account_status, whose owner had
-- changed, or that had been granted to anon. Every one of those is a privacy regression, and every
-- one survives a marker check. So the whole contract is pinned: definition, ordered columns with
-- types, options, owner, grants, and the identity and body of can_discover_profile().
--
-- WHERE THE EXPECTED VIEW DEFINITION COMES FROM. Not from a guess. pg_get_viewdef() returns the
-- PARSED, NORMALIZED text as the deployed server renders it, which no repository file can predict.
-- The baseline was therefore READ from production by 082_preflight.sql, reviewed, and pinned below
-- as constants. This file is self-contained: paste it once into the Supabase SQL Editor and run it.
-- There is nothing to set beforehand and no client-specific command anywhere in it.
--
-- The replacement is verified twice: the pre-state is asserted against the baseline BEFORE anything
-- is written, and the post-state is re-read and asserted to differ from the pre-state ONLY by the
-- appended boolean. Both live in one DO block inside the single transaction, so either check failing
-- rolls back the columns, the table, the functions, the triggers, the indexes and the view together.
DO $viewguard$
DECLARE
  c_view constant regclass := 'public.public_profiles'::pg_catalog.regclass;

  -- ─── THE PRODUCTION PRIVACY BASELINE, PINNED AS CONSTANTS ─────────────────────────────────
  -- Read from the deployed database by supabase/audits/082_preflight.sql and reviewed before being
  -- written here. They are literals, not settings: a SET LOCAL would have to take effect inside this
  -- same transaction, which a separately submitted Supabase SQL Editor statement cannot guarantee,
  -- and a baseline that silently fails to arrive is worse than no baseline. Constants cannot go
  -- missing, and they are reviewable in the artifact itself.
  c_expect_md5   constant text := '4f7055f696f341f3c508d65b26fb6703';
  c_expect_owner constant text := 'postgres';
  c_expect_acl   constant text := 'postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres,authenticated=r/postgres';
  c_expect_cdp   constant text := '43624624c629e2d67978db0e9745ae1c';
  -- Ordinals 19 and 20 are JSONB, not text[]. previous_roles stores an ARRAY OF OBJECTS
  -- ({company,title,start_date,end_date}) and current_focus_areas was created jsonb by migration
  -- 041 — neither has ever been a text array. An earlier draft of this file guessed text[] from the
  -- genuinely-text[] neighbours (interests, purposes, intro_preferences) and was wrong.
  c_expect_cols  constant text := '1:id:uuid,2:full_name:text,3:avatar_url:text,4:title:text,5:exact_job_title:text,6:company:text,7:company_id:uuid,8:role_type:text,9:seniority:text,10:location:text,11:bio:text,12:expertise:text,13:interests:text[],14:purposes:text[],15:intro_preferences:text[],16:mentorship_role:text,17:open_to_mentorship:boolean,18:open_to_business_solutions:boolean,19:current_focus_areas:jsonb,20:previous_roles:jsonb';
  v_def_before text;
  v_def_after  text;
  v_md5_before text;
  v_cols_before text;
  v_cols_after  text;
  v_owner_before text;
  v_owner_after  text;
  v_acl_before  text;
  v_acl_after   text;
  v_opts_before text;
  v_opts_after  text;
  v_barrier_before boolean; v_barrier_after boolean;
  v_invoker_before boolean; v_invoker_after boolean;
  v_cdp_oid    oid;
  v_cdp_md5    text;
  v_cdp_md5_after text;
  v_cdp_ident  text;
  v_cdp_cfg    text;
  v_cdp_secdef boolean;
BEGIN
  ------------------------------------------------------------------ (a) capture the deployed contract
  v_def_before := pg_catalog.pg_get_viewdef(c_view, true);
  v_md5_before := pg_catalog.md5(v_def_before);

  SELECT pg_catalog.string_agg(
           a.attnum::text || ':' || a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod),
           ',' ORDER BY a.attnum)
    INTO v_cols_before
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = c_view AND a.attnum > 0 AND NOT a.attisdropped;

  SELECT pg_catalog.pg_get_userbyid(c.relowner),
         COALESCE(pg_catalog.array_to_string(c.relacl::text[], ','), '(NONE)'),
         COALESCE(pg_catalog.array_to_string(c.reloptions, ','), '(NONE)')
    INTO v_owner_before, v_acl_before, v_opts_before
    FROM pg_catalog.pg_class c WHERE c.oid = c_view;

  ------------------------------------------------------------------ (b) assert the pinned baseline
  IF v_md5_before <> c_expect_md5 THEN
    RAISE EXCEPTION
      '082: public_profiles definition md5 is % but the audited baseline is %. The deployed privacy '
      'contract is NOT the one this migration was reviewed against.', v_md5_before, c_expect_md5;
  END IF;

  -- Owner and grants are pinned to the PRODUCTION baseline, not merely compared before-and-after.
  -- A before/after comparison is blind to a change that happened BEFORE this migration ran, which is
  -- exactly the case that matters: a definer view runs with its owner's privileges, so an owner that
  -- has silently moved is a different security posture even though the definition is untouched.
  IF v_owner_before <> c_expect_owner THEN
    RAISE EXCEPTION
      '082: public_profiles owner is % but the audited baseline is %. A DEFINER view runs as its '
      'owner, so this is a changed security posture.', v_owner_before, c_expect_owner;
  END IF;
  IF v_acl_before <> c_expect_acl THEN
    RAISE EXCEPTION
      '082: public_profiles grants are [%] but the audited baseline is [%].',
      v_acl_before, c_expect_acl;
  END IF;

  -- The exact ordered column contract from migration 057. Independent of the md5: a server that
  -- rendered the definition differently would still have to present these columns, in this order.
  IF v_cols_before <> c_expect_cols THEN
    RAISE EXCEPTION
      '082: public_profiles ordered column contract differs from the audited one. deployed: [%]',
      v_cols_before;
  END IF;

  v_barrier_before := EXISTS (SELECT 1 FROM pg_catalog.pg_options_to_table(
                        (SELECT reloptions FROM pg_catalog.pg_class WHERE oid = c_view)) o
                       WHERE o.option_name = 'security_barrier'
                         AND pg_catalog.lower(o.option_value) IN ('true','on','1'));
  v_invoker_before := EXISTS (SELECT 1 FROM pg_catalog.pg_options_to_table(
                        (SELECT reloptions FROM pg_catalog.pg_class WHERE oid = c_view)) o
                       WHERE o.option_name = 'security_invoker'
                         AND pg_catalog.lower(o.option_value) IN ('true','on','1'));
  IF NOT v_barrier_before THEN
    RAISE EXCEPTION '082: public_profiles is not a security_barrier view (options: %).', v_opts_before;
  END IF;
  -- Definer posture. PostgreSQL 15+ records security_invoker; its ABSENCE means definer, which is
  -- what 057 created. An explicitly TRUE security_invoker would make the view run as the caller and
  -- silently change who can see which rows, so it is refused.
  IF v_invoker_before THEN
    RAISE EXCEPTION '082: public_profiles is security_invoker; the audited view is a DEFINER view.';
  END IF;

  -- Grants. SELECT to authenticated and nothing to anon or PUBLIC is the whole member-facing surface.
  IF pg_catalog.has_table_privilege('anon', c_view, 'SELECT') THEN
    RAISE EXCEPTION '082: anon can SELECT public_profiles; refusing to extend a leaking view.';
  END IF;
  IF NOT pg_catalog.has_table_privilege('authenticated', c_view, 'SELECT') THEN
    RAISE EXCEPTION '082: authenticated cannot SELECT public_profiles; the deployed grants differ.';
  END IF;
  FOR v_cols_after IN SELECT unnest(ARRAY['INSERT','UPDATE','DELETE']) LOOP
    IF pg_catalog.has_table_privilege('authenticated', c_view, v_cols_after)
       OR pg_catalog.has_table_privilege('anon', c_view, v_cols_after) THEN
      RAISE EXCEPTION '082: a browser role holds % on public_profiles.', v_cols_after;
    END IF;
  END LOOP;
  v_cols_after := NULL;

  ------------------------------------------------------------------ (c) the discovery predicate
  v_cdp_oid := pg_catalog.to_regprocedure('public.can_discover_profile(uuid)');
  IF v_cdp_oid IS NULL THEN
    RAISE EXCEPTION '082: can_discover_profile(uuid) is absent under that exact signature.';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'can_discover_profile') <> 1 THEN
    RAISE EXCEPTION '082: can_discover_profile has an unexpected overload; refusing to proceed.';
  END IF;
  SELECT pg_catalog.md5(p.prosrc), pg_catalog.pg_get_function_identity_arguments(p.oid),
         COALESCE(pg_catalog.array_to_string(p.proconfig, ','), '(NONE)'), p.prosecdef
    INTO v_cdp_md5, v_cdp_ident, v_cdp_cfg, v_cdp_secdef
    FROM pg_catalog.pg_proc p WHERE p.oid = v_cdp_oid;
  IF v_cdp_ident <> 'member_id uuid' THEN
    RAISE EXCEPTION '082: can_discover_profile identity arguments are [%], expected [member_id uuid].', v_cdp_ident;
  END IF;
  IF NOT v_cdp_secdef THEN
    RAISE EXCEPTION '082: can_discover_profile is no longer SECURITY DEFINER.';
  END IF;
  IF v_cdp_cfg NOT IN ('search_path=', 'search_path=""') THEN
    RAISE EXCEPTION '082: can_discover_profile does not have an empty search_path (config: %).', v_cdp_cfg;
  END IF;
  -- Pinned to the PRODUCTION baseline, for the same reason the owner is: a predicate that was
  -- loosened BEFORE this migration ran would sail past a before/after comparison, and the view's
  -- definition never changes when only the function body does. This is the check that catches a
  -- widened discovery rule, which is the single most damaging thing that could be true here.
  IF v_cdp_md5 <> c_expect_cdp THEN
    RAISE EXCEPTION
      '082: can_discover_profile body md5 is % but the audited baseline is %. The deployed discovery '
      'rule is NOT the one this migration was reviewed against.', v_cdp_md5, c_expect_cdp;
  END IF;

  ------------------------------------------------------------------ (d) NOW replace the view
  -- Every pre-existing column and expression is restated exactly as migration 057 wrote it; the ONLY
  -- difference is is_andrel_connector appended at the end. The post-condition below is what proves
  -- that claim rather than asserting it.
  EXECUTE $ddl$
    CREATE OR REPLACE VIEW public.public_profiles
      WITH (security_invoker = off, security_barrier = on) AS
      SELECT
        id, full_name, avatar_url, title, exact_job_title, company, company_id,
        role_type, seniority, location, bio, expertise, interests, purposes,
        intro_preferences, mentorship_role, open_to_mentorship,
        open_to_business_solutions, current_focus_areas, previous_roles,
        is_andrel_connector
      FROM public.profiles
      WHERE public.can_discover_profile(id)
  $ddl$;

  ------------------------------------------------------------------ (e) post-condition, same txn
  v_def_after := pg_catalog.pg_get_viewdef(c_view, true);
  SELECT pg_catalog.string_agg(
           a.attnum::text || ':' || a.attname || ':' || pg_catalog.format_type(a.atttypid, a.atttypmod),
           ',' ORDER BY a.attnum)
    INTO v_cols_after
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = c_view AND a.attnum > 0 AND NOT a.attisdropped;
  SELECT pg_catalog.pg_get_userbyid(c.relowner),
         COALESCE(pg_catalog.array_to_string(c.relacl::text[], ','), '(NONE)'),
         COALESCE(pg_catalog.array_to_string(c.reloptions, ','), '(NONE)')
    INTO v_owner_after, v_acl_after, v_opts_after
    FROM pg_catalog.pg_class c WHERE c.oid = c_view;
  v_barrier_after := EXISTS (SELECT 1 FROM pg_catalog.pg_options_to_table(
                       (SELECT reloptions FROM pg_catalog.pg_class WHERE oid = c_view)) o
                      WHERE o.option_name = 'security_barrier'
                        AND pg_catalog.lower(o.option_value) IN ('true','on','1'));
  v_invoker_after := EXISTS (SELECT 1 FROM pg_catalog.pg_options_to_table(
                       (SELECT reloptions FROM pg_catalog.pg_class WHERE oid = c_view)) o
                      WHERE o.option_name = 'security_invoker'
                        AND pg_catalog.lower(o.option_value) IN ('true','on','1'));

  -- The columns must be the pinned twenty, in the same order and types, plus exactly one appended.
  IF v_cols_after <> v_cols_before || ',21:is_andrel_connector:boolean' THEN
    RAISE EXCEPTION
      '082: the replaced view is not the original plus one appended boolean.%  before: [%]%  after:  [%]',
      pg_catalog.chr(10), v_cols_before, pg_catalog.chr(10), v_cols_after;
  END IF;
  IF v_owner_after <> v_owner_before THEN
    RAISE EXCEPTION '082: view owner changed from % to %.', v_owner_before, v_owner_after;
  END IF;
  IF v_acl_after IS DISTINCT FROM v_acl_before THEN
    RAISE EXCEPTION '082: view grants changed.%  before: [%]%  after:  [%]',
      pg_catalog.chr(10), v_acl_before, pg_catalog.chr(10), v_acl_after;
  END IF;
  -- Compare the POSTURE, not the encoding. Restating `security_invoker = off` records the option
  -- explicitly where it had been absent, so the raw reloptions STRING legitimately changes while the
  -- security posture is identical (absent means off). A string comparison here would fail the very
  -- replacement it is meant to protect — and, worse, would tempt someone to delete the check. What
  -- must hold is that the view is still a barrier and still a definer, before and after.
  IF NOT (v_barrier_after AND NOT v_invoker_after) THEN
    RAISE EXCEPTION
      '082: view security posture changed. before: barrier=% invoker=% [%] after: barrier=% invoker=% [%]',
      v_barrier_before, v_invoker_before, v_opts_before, v_barrier_after, v_invoker_after, v_opts_after;
  END IF;
  IF v_barrier_after IS DISTINCT FROM v_barrier_before OR v_invoker_after IS DISTINCT FROM v_invoker_before THEN
    RAISE EXCEPTION
      '082: view security posture moved. before: barrier=% invoker=%  after: barrier=% invoker=%',
      v_barrier_before, v_invoker_before, v_barrier_after, v_invoker_after;
  END IF;
  -- The row-scoping predicate must still be the one that was pinned above, unchanged.
  IF pg_catalog.strpos(v_def_after, 'can_discover_profile') = 0 THEN
    RAISE EXCEPTION '082: the replaced view no longer applies can_discover_profile.';
  END IF;
  SELECT pg_catalog.md5(p.prosrc) INTO v_cdp_md5_after
    FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('public.can_discover_profile(uuid)');
  IF v_cdp_md5_after IS DISTINCT FROM v_cdp_md5 THEN
    RAISE EXCEPTION '082: can_discover_profile changed during apply.';
  END IF;

  RAISE NOTICE '082: public_profiles extended by is_andrel_connector only (owner, grants, options and discovery predicate unchanged).';
END;
$viewguard$;

-- ── 6. NO BROWSER ROLE MAY WRITE THE BADGE ────────────────────────────────────────────────────
-- Migration 055 revoked browser DML on profiles; restated here because these are NEW columns and a
-- column-level grant elsewhere would otherwise be invisible to this review.
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM PUBLIC, anon, authenticated;
REVOKE UPDATE (is_andrel_connector, andrel_connector_awarded_at, andrel_connector_awarded_by)
  ON public.profiles FROM PUBLIC, anon, authenticated;

COMMIT;
