-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 084  INTRODUCTION GUIDANCE — forward-only enrollment + a durable, self-only dismissal
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS IS FOR. The Introductions page shows a richer one-time explainer the first time a
-- NEWLY ENROLLED member is looking at real, actionable introductions. Two facts have to survive a
-- browser, a device change and a sign-out, so both live on the member's profile row:
--
--   intro_guidance_enrolled_at                 when this member completed their profile AFTER this
--                                              migration shipped — i.e. whether they are "new".
--   intro_first_batch_explainer_dismissed_at   when they closed the explainer.
--
-- ─── NO BACKFILL. THIS IS THE ENTIRE SAFETY MECHANISM. ────────────────────────────────────────
-- Both columns are added NULL with no DEFAULT and this file writes NO rows. Every profile that
-- exists when 084 is applied therefore has intro_guidance_enrolled_at = NULL, and the application
-- treats NULL as "not enrolled" — so no historical member can ever be shown the one-time explainer.
-- Enrollment is stamped going forward by the two (and only two) writers that set
-- profile_complete = true: completeOnboarding in app/actions.ts and POST /api/profile/complete.
-- Both stamp it only when it is still NULL, so re-completing a profile never re-enrolls anyone.
--
-- Deliberately NOT derived from created_at, profile_complete, onboarding_step or any existing
-- timestamp: every one of those is already true for the whole member base, which is exactly the
-- accidental mass-enrollment this column exists to make impossible.
--
-- ─── ENROLLMENT IS ATOMIC, AND THERE IS EXACTLY ONE AUTHORITY ─────────────────────────────────
-- The stamp is written by a BEFORE trigger on public.profiles, in the same statement that makes the
-- profile complete. Not by the application: an application-level "stamp afterwards" call is a second
-- write that can lose its race, fail independently, or simply be forgotten by a third writer added
-- later, leaving a complete profile that is silently unenrolled. There are two writers today
-- (completeOnboarding's upsert and POST /api/profile/complete) and the trigger covers both, plus
-- any future one, because it sits on the table rather than on a code path.
--
-- The rule, stated once:
--   INSERT with profile_complete = true                       -> stamp
--   UPDATE moving profile_complete from NOT-true to true      -> stamp
--   UPDATE of a profile that was ALREADY complete             -> do NOT stamp (historical members)
--   any write when the stamp is already set                   -> leave it alone
-- so repeating onboarding can neither enrol a historical member nor reset an existing stamp, and
-- the dismissal column is never touched by the trigger at all.
--
-- ─── WHAT THIS MIGRATION DOES NOT TOUCH ───────────────────────────────────────────────────────
-- No matching, capacity, expiry, rotation, pair, credit, notification or email behaviour. No
-- existing column, constraint, index, policy, function or grant is altered. intro_requests,
-- member_pairs, matches, meeting_credits and recommendation_batches are not referenced at all.
-- These are two additive, nullable, member-private UI-preference columns and nothing else.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. PRECONDITIONS — fail closed before any DDL ─────────────────────────────────────────────
DO $guard$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      RAISE EXCEPTION
        'DRIFT GUARD 084: role % does not exist. This is not the environment 084 was audited '
        'against; refusing to apply.', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'DRIFT GUARD 084: public.profiles does not exist.';
  END IF;

  -- The privacy posture 084 must preserve: migration 058 revoked SELECT on public.profiles from
  -- `authenticated`, and 055 revoked browser DML. If either has been re-granted, this environment
  -- is not the one these columns were reviewed against and adding member-private columns to it
  -- would widen exposure silently.
  --
  -- ONLY THE VALUE-BEARING PRIVILEGES ARE CHECKED HERE. SELECT, INSERT, UPDATE and DELETE are the
  -- privileges that can read or change a member's data. TRUNCATE, REFERENCES and TRIGGER cannot:
  -- REFERENCES only permits creating a foreign key that points at a column, which reveals no value
  -- and changes none. Production carries all three on anon/authenticated by inheritance, and an
  -- earlier draft of this guard wrongly refused that posture as "browser-writable". It is not
  -- exposure — but it is unnecessary power on a members table, so section 3 REVOKES it rather than
  -- refusing to proceed.
  IF pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'SELECT')
     OR pg_catalog.has_table_privilege('anon', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION
      'DRIFT GUARD 084: a browser role has SELECT on public.profiles; migration 058''s posture '
      'is not in force. Refusing to add member-private columns.';
  END IF;
  IF pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'INSERT')
     OR pg_catalog.has_table_privilege('anon', 'public.profiles', 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
     OR pg_catalog.has_table_privilege('anon', 'public.profiles', 'UPDATE')
     OR pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'DELETE')
     OR pg_catalog.has_table_privilege('anon', 'public.profiles', 'DELETE') THEN
    RAISE EXCEPTION
      'DRIFT GUARD 084: a browser role has INSERT, UPDATE or DELETE on public.profiles; migration '
      '055''s posture is not in force. Refusing to add columns a member could write directly.';
  END IF;

  -- service_role must still be able to do what the server actually does to this table: SELECT
  -- (138 call sites), INSERT (1), UPDATE (32), DELETE (1 — waitlist revoke). If it cannot, section
  -- 3's REVOKE would be the thing that broke the application, so refuse before touching anything.
  IF NOT (pg_catalog.has_table_privilege('service_role', 'public.profiles', 'SELECT')
      AND pg_catalog.has_table_privilege('service_role', 'public.profiles', 'INSERT')
      AND pg_catalog.has_table_privilege('service_role', 'public.profiles', 'UPDATE')
      AND pg_catalog.has_table_privilege('service_role', 'public.profiles', 'DELETE')) THEN
    RAISE EXCEPTION
      'DRIFT GUARD 084: service_role lacks SELECT/INSERT/UPDATE/DELETE on public.profiles. The '
      'server cannot run in this environment; refusing to change privileges.';
  END IF;
END
$guard$;

-- ── 2. THE TWO COLUMNS ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS intro_guidance_enrolled_at timestamptz NULL;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS intro_first_batch_explainer_dismissed_at timestamptz NULL;

COMMENT ON COLUMN public.profiles.intro_guidance_enrolled_at IS
  'When this member completed their profile AFTER migration 084 shipped. NULL means "not enrolled" '
  'and is the value every pre-084 profile keeps forever: 084 performs no backfill, and the value is '
  'never inferred from created_at, profile_complete or onboarding_step. Gates the one-time '
  'first-introductions explainer only. Read by no matching, capacity or eligibility path.';

COMMENT ON COLUMN public.profiles.intro_first_batch_explainer_dismissed_at IS
  'When the member closed the one-time first-introductions explainer. Member-private UI preference; '
  'affects nothing but whether that one panel renders. Written only by the self-scoped dismissal '
  'server action, never by a browser and never for another member.';

-- ── 3. PRIVILEGE POSTURE ──────────────────────────────────────────────────────────────────────
-- Adding a column to an existing table creates NO new grant: column privileges are inherited from
-- the table, and Supabase's ALTER DEFAULT PRIVILEGES applies to new TABLES, not new columns. So
-- these two columns arrive with exactly the table's posture and nothing else.
--
-- THAT POSTURE HAS THREE PRIVILEGES ON IT THAT NOBODY NEEDS. Production shows anon and
-- authenticated holding TRUNCATE, REFERENCES and TRIGGER on public.profiles — inherited from
-- Supabase's default GRANT ALL, never deliberately given, and never revoked by 055 or 058 because
-- those migrations targeted the value-bearing privileges.
--
--   TRUNCATE   would let a browser role empty the entire members table in one statement. It is not
--              covered by RLS. This is the materially dangerous one.
--   TRIGGER    would let a browser role attach a trigger function to public.profiles and have it
--              run under every writer, including service_role.
--   REFERENCES would let a browser role create a foreign key pointing at a profiles column. It
--              reveals no value and changes none — it is NOT read or write exposure, and this file
--              does not claim otherwise — but it constrains what the owner may later drop or alter,
--              and no browser role has any reason to hold it.
--
-- So we revoke all three. NOTHING IS GRANTED IN RETURN, and the browser SELECT/INSERT/UPDATE/DELETE
-- restrictions established by 055 and 058 are left exactly as they are.
REVOKE TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.profiles
  FROM PUBLIC, anon, authenticated;

-- The column-level guard, corrected. It fails ONLY on privileges that can expose or modify a column
-- value — SELECT, INSERT, UPDATE. A column-level REFERENCES grant is neither, and refusing on it
-- (as an earlier draft did) would reject a correct production database.
DO $acl$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT g.grantee, g.column_name, g.privilege_type
      FROM information_schema.column_privileges g
     WHERE g.table_schema = 'public'
       AND g.table_name   = 'profiles'
       AND g.column_name IN ('intro_guidance_enrolled_at', 'intro_first_batch_explainer_dismissed_at')
       AND g.grantee IN ('anon', 'authenticated', 'PUBLIC')
       AND g.privilege_type IN ('SELECT', 'INSERT', 'UPDATE')   -- value-bearing only
  LOOP
    RAISE EXCEPTION
      'MIGRATION 084: column-level % on public.profiles.% is granted to %; these columns must be '
      'readable and writable only through service_role. Refusing to leave a browser-reachable '
      'member flag.',
      r.privilege_type, r.column_name, r.grantee;
  END LOOP;
END
$acl$;

-- ── 4. THE ENROLLMENT AUTHORITY (BEFORE trigger, one writer, no application call) ────────────
-- SECURITY INVOKER: it runs as whoever writes the row (service_role) and needs no privilege of its
-- own — a SECURITY DEFINER trigger here would be strictly more power for no benefit. search_path is
-- empty and every reference is schema-qualified, so it cannot be captured by a search_path attack.
CREATE OR REPLACE FUNCTION public.tg_stamp_intro_guidance_enrollment()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = ''
AS $fn$
BEGIN
  -- Never overwrite an existing stamp: enrollment happens once, and repeating onboarding must not
  -- show the one-time explainer a second time.
  IF NEW.intro_guidance_enrolled_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.profile_complete IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A profile created already-complete is a new member completing onboarding in one statement.
    NEW.intro_guidance_enrolled_at := pg_catalog.now();
  ELSIF TG_OP = 'UPDATE' AND OLD.profile_complete IS DISTINCT FROM TRUE THEN
    -- THE TRANSITION, and only the transition. A profile that was already complete before this
    -- statement is a historical member and is deliberately left unenrolled, however many times it
    -- is written again.
    NEW.intro_guidance_enrolled_at := pg_catalog.now();
  END IF;

  RETURN NEW;
END
$fn$;

-- PostgreSQL grants EXECUTE on every new function to PUBLIC. A trigger function is invoked by the
-- executor, never by a client, so nobody needs that grant.
REVOKE ALL ON FUNCTION public.tg_stamp_intro_guidance_enrollment() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tg_stamp_intro_guidance_enrollment() IS
  'Stamps profiles.intro_guidance_enrolled_at atomically with the profile''s FIRST transition to '
  'complete (INSERT complete, or UPDATE from not-true to true). Never stamps an already-complete '
  'profile, never overwrites an existing stamp, and never touches any other column. The single '
  'enrollment authority — see migration 084.';

DROP TRIGGER IF EXISTS stamp_intro_guidance_enrollment ON public.profiles;
-- Scoped as narrowly as PostgreSQL allows: BEFORE (so it sets a value rather than issuing a second
-- write), FOR EACH ROW, and UPDATE OF profile_complete so an unrelated profile edit does not even
-- enter the function.
CREATE TRIGGER stamp_intro_guidance_enrollment
  BEFORE INSERT OR UPDATE OF profile_complete ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_stamp_intro_guidance_enrollment();

-- ── 5. POSTCONDITIONS — inside the same transaction, so a failure rolls the DDL back ──────────
DO $verify$
DECLARE
  v_enrolled_null  bigint;
  v_dismissed_null bigint;
  v_total          bigint;
  v_trg            integer;
  v_col            record;
  v_role           text;
BEGIN
  FOR v_col IN
    SELECT * FROM (VALUES
      ('intro_guidance_enrolled_at'),
      ('intro_first_batch_explainer_dismissed_at')
    ) AS t(name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.profiles'::pg_catalog.regclass
         AND a.attname = v_col.name AND NOT a.attisdropped
    ) THEN
      RAISE EXCEPTION 'MIGRATION 084: column % was not created.', v_col.name;
    END IF;

    -- Nullable, and no DEFAULT: a DEFAULT would be a backfill by another name.
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.profiles'::pg_catalog.regclass
         AND a.attname = v_col.name AND (a.attnotnull OR a.atthasdef)
    ) THEN
      RAISE EXCEPTION 'MIGRATION 084: column % must be nullable with no default.', v_col.name;
    END IF;
  END LOOP;

  -- THE no-backfill proof: every existing row is NULL on both columns.
  SELECT count(*),
         count(*) FILTER (WHERE intro_guidance_enrolled_at IS NOT NULL),
         count(*) FILTER (WHERE intro_first_batch_explainer_dismissed_at IS NOT NULL)
    INTO v_total, v_enrolled_null, v_dismissed_null
    FROM public.profiles;

  IF v_enrolled_null <> 0 OR v_dismissed_null <> 0 THEN
    RAISE EXCEPTION
      'MIGRATION 084: % of % profiles carry a non-NULL enrollment stamp and % a dismissal stamp. '
      'No profile may be enrolled by this migration — historical members must never see the '
      'one-time explainer.', v_enrolled_null, v_total, v_dismissed_null;
  END IF;

  -- ── PRIVILEGE POSTCONDITIONS ───────────────────────────────────────────────────────────────
  -- All SEVEN table privileges, for all THREE browser identities, proven absent. Checked by name
  -- rather than as a set so the failure message says exactly which one survived.
  FOR v_col IN
    SELECT * FROM (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'))
      AS t(name)
  LOOP
    FOREACH v_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'public.profiles', v_col.name) THEN
        RAISE EXCEPTION
          'MIGRATION 084: role % still has % on public.profiles after the revoke.', v_role, v_col.name;
      END IF;
    END LOOP;
    -- PUBLIC is not a role has_table_privilege can be asked about, so it is read from the ACL.
    IF EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class c,
             LATERAL pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
       WHERE c.oid = 'public.profiles'::pg_catalog.regclass
         AND a.grantee = 0                                   -- 0 = PUBLIC
         AND a.privilege_type = v_col.name
    ) THEN
      RAISE EXCEPTION 'MIGRATION 084: PUBLIC still has % on public.profiles after the revoke.', v_col.name;
    END IF;
  END LOOP;

  -- service_role keeps everything the server actually uses. If the revoke above had touched it,
  -- this aborts and rolls the whole migration back rather than leaving a broken application.
  FOR v_col IN SELECT * FROM (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) AS t(name)
  LOOP
    IF NOT pg_catalog.has_table_privilege('service_role', 'public.profiles', v_col.name) THEN
      RAISE EXCEPTION
        'MIGRATION 084: service_role lost % on public.profiles. The server needs SELECT (138 call '
        'sites), INSERT (1), UPDATE (32) and DELETE (1).', v_col.name;
    END IF;
  END LOOP;
  -- And it can still read/write the two new columns specifically.
  IF NOT (pg_catalog.has_column_privilege('service_role','public.profiles','intro_guidance_enrolled_at','SELECT')
      AND pg_catalog.has_column_privilege('service_role','public.profiles','intro_guidance_enrolled_at','UPDATE')
      AND pg_catalog.has_column_privilege('service_role','public.profiles','intro_first_batch_explainer_dismissed_at','SELECT')
      AND pg_catalog.has_column_privilege('service_role','public.profiles','intro_first_batch_explainer_dismissed_at','UPDATE')) THEN
    RAISE EXCEPTION 'MIGRATION 084: service_role cannot read/write the two new columns.';
  END IF;

  -- The enrollment authority exists, is attached, and is the ONLY one.
  IF pg_catalog.to_regprocedure('public.tg_stamp_intro_guidance_enrollment()') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION 084: the enrollment trigger function was not created.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
     WHERE tgrelid = 'public.profiles'::pg_catalog.regclass
       AND tgname = 'stamp_intro_guidance_enrollment' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'MIGRATION 084: the enrollment trigger is not attached to public.profiles.';
  END IF;
  SELECT count(*) INTO v_trg
    FROM pg_catalog.pg_trigger
   WHERE tgrelid = 'public.profiles'::pg_catalog.regclass AND NOT tgisinternal
     -- 'enroll' not 'enrolled': the trigger def names tg_stamp_intro_guidance_enrollMENT
     AND pg_catalog.pg_get_triggerdef(oid) ILIKE '%intro_guidance_enroll%';
  IF v_trg <> 1 THEN
    RAISE EXCEPTION
      'MIGRATION 084: % enrollment triggers on public.profiles; exactly 1 authority is permitted.', v_trg;
  END IF;
  IF pg_catalog.has_function_privilege('anon', 'public.tg_stamp_intro_guidance_enrollment()', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.tg_stamp_intro_guidance_enrollment()', 'EXECUTE') THEN
    RAISE EXCEPTION 'MIGRATION 084: a browser role can EXECUTE the enrollment trigger function.';
  END IF;

  RAISE NOTICE '084 OK — 2 columns + 1 enrollment trigger, % profiles, 0 enrolled, 0 dismissed '
    '(no backfill). Browser roles hold none of SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/'
    'TRIGGER on public.profiles; service_role unchanged.', v_total;
END
$verify$;

COMMIT;
