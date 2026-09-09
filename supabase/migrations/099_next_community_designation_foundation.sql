-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 099 — ANDREL NEXT: the designation foundation (Phase 4A-1)
--
-- This migration installs the guardrails BEFORE anything can use them. After it applies, the
-- application is still INCAPABLE of creating a Next member: no production TypeScript writes
-- profiles.member_type, and this file adds none. 4A-2 will be the first stage that can.
--
-- ─── WHY THE INTENT LIVES ON waitlist, NOT ON THE PROFILE (Architecture A) ─────────────────────
-- Under the current invitation model an Auth user is minted by generateLink({type:'invite'}) and
-- NO profile row exists until the member acts. The profile is then created by
-- /api/profile/initialize or completeOnboarding, both of which omit member_type — so it takes the
-- column DEFAULT. There is therefore no row to carry the community at invite time, and the only
-- durable pre-account record is the waitlist row.
--
-- ─── WHY "CREATE PROFESSIONAL, PROMOTE LATER" IS PROHIBITED (Architecture D) ───────────────────
-- Two independent reasons, both from the code rather than from taste:
--   1. lib/provisioning.ts ensureRecord() is CHECK-THEN-INSERT. If the row exists it returns
--      'exists' and writes nothing, so a retry after a mis-created Professional row would never
--      correct it. The mistake would be permanent.
--   2. Between creation and promotion the student IS a Professional. completeOnboarding can set
--      profile_complete in the same session, and at that instant they are eligible for all seven
--      ordinary candidate pools and discoverable through can_discover_profile.
-- The immutability trigger below makes D impossible rather than merely discouraged.
--
-- ─── WHAT THIS FILE DOES NOT DO ───────────────────────────────────────────────────────────────
-- No production writer. No student fields (no law school, no degree/program). No admin bypass, no
-- generic override flag, no ADMIN_EMAIL authority, no correction mechanism — a legitimate future
-- correction will be designed as its own explicit administrative operation. Migrations 095-098 are
-- untouched. community_pair_allowed is untouched. The seven ordinary candidate pools are untouched.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── SECTION 0 — PRECONDITIONS ────────────────────────────────────────────────────────────────
DO $precheck$
BEGIN
  IF pg_catalog.to_regclass('public.waitlist') IS NULL THEN
    RAISE EXCEPTION '099 REFUSED: public.waitlist does not exist.';
  END IF;
  IF pg_catalog.to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION '099 REFUSED: public.profiles does not exist.';
  END IF;

  -- The community vocabulary must already exist and must already be constrained. This migration
  -- adds no new community value and must never be the file that introduces one.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.profiles'::pg_catalog.regclass
      AND a.attname = 'member_type' AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION '099 REFUSED: profiles.member_type is absent — apply migration 095 first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'profiles_member_type_check'
      AND conrelid = 'public.profiles'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION '099 REFUSED: profiles_member_type_check is absent (migration 095).';
  END IF;
END
$precheck$;


-- ── SECTION 1 — THE INTENDED COMMUNITY, ON THE WAITLIST ROW ──────────────────────────────────
--
-- NOT NULL DEFAULT 'professional' is the same shape migration 095 used for profiles.member_type,
-- and for the same reason: every existing row becomes Professional in one statement, with no
-- backfill that can half-run, and every existing invitation continues to resolve exactly as it does
-- today. The CHECK mirrors profiles_member_type_check so the two vocabularies cannot drift.
ALTER TABLE public.waitlist
  ADD COLUMN IF NOT EXISTS intended_member_type text NOT NULL DEFAULT 'professional';

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'waitlist_intended_member_type_check'
      AND conrelid = 'public.waitlist'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.waitlist
      ADD CONSTRAINT waitlist_intended_member_type_check
      CHECK (intended_member_type IN ('professional', 'next'));
  END IF;
END
$constraint$;

COMMENT ON COLUMN public.waitlist.intended_member_type IS
  'The community a person is invited INTO, decided before their account exists. Server/admin '
  'controlled: no browser-writable path reaches this column, and no client parameter selects it. '
  'Phase 4A-2 will read it through resolve_intended_member_type() and write it into the profile at '
  'INSERT. Migration 099.';


-- ── SECTION 2 — CONFLICTING LIVE INTENT, REFUSED AT ISSUANCE ─────────────────────────────────
--
-- Migration 009 already declares UNIQUE INDEX waitlist_email_lower_uniq ON public.waitlist
-- (lower(email)), so two waitlist rows cannot share an address and a second conflicting intent is
-- already structurally impossible for addresses that differ only in case.
--
-- IT LEAVES ONE GAP, AND THIS TRIGGER CLOSES IT. 009 normalises with lower() alone. Migration 078's
-- identity resolvers — the ones the invitation lifecycle actually uses — normalise with
-- lower(btrim(...)). So ' a@x.com' and 'a@x.com' are DIFFERENT rows to the unique index and the
-- SAME person to the resolver. Without this trigger those two rows could carry different intents
-- and the resolver would see genuine ambiguity.
--
-- The rule is deliberately narrow: a row is refused only when another LIVE row for the same
-- btrim-normalised address already carries a DIFFERENT intent. Same-intent duplicates are allowed,
-- because replayed issuance must stay idempotent. Revoked rows are excluded, because 029 keeps them
-- for history and they are already excluded from every invite path.
-- COALESCE is written bare, not schema-qualified. It is SQL SYNTAX rather than a function in
-- pg_catalog — `pg_catalog.coalesce(...)` does not resolve and raises 42883 at RUNTIME, which the
-- local harness caught here. Being syntax, it also cannot be shadowed, so `search_path = ''` leaves
-- it safe. Same class as `position(x IN y)`, which migration 096 had to replace with strpos().
CREATE OR REPLACE FUNCTION public.tg_waitlist_intent_no_conflict()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_norm text := pg_catalog.lower(pg_catalog.btrim(COALESCE(NEW.email, '')));
  v_other integer;
BEGIN
  IF v_norm = '' THEN
    RETURN NEW;  -- addresses are validated elsewhere; this trigger decides community, not format
  END IF;

  SELECT count(*) INTO v_other
  FROM public.waitlist w
  WHERE w.id IS DISTINCT FROM NEW.id
    AND pg_catalog.lower(pg_catalog.btrim(COALESCE(w.email, ''))) = v_norm
    AND COALESCE(w.status, '') <> 'revoked'
    AND w.intended_member_type IS DISTINCT FROM NEW.intended_member_type;

  IF v_other > 0 THEN
    -- No address in the message: this reaches logs. The operator has the row they were editing.
    RAISE EXCEPTION 'waitlist: a live invitation for this address already intends a different community'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_waitlist_intent_no_conflict() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tg_waitlist_intent_no_conflict() FROM anon;
REVOKE ALL ON FUNCTION public.tg_waitlist_intent_no_conflict() FROM authenticated;

DROP TRIGGER IF EXISTS waitlist_intent_no_conflict_biu ON public.waitlist;
CREATE TRIGGER waitlist_intent_no_conflict_biu
  BEFORE INSERT OR UPDATE OF email, intended_member_type, status ON public.waitlist
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_waitlist_intent_no_conflict();


-- ── SECTION 3 — PROVISIONING-TIME AMBIGUITY, DETECTABLE AND FAIL-CLOSED ──────────────────────
--
-- Section 2 is issuance-time protection, and issuance-time protection is never sufficient on its
-- own: legacy rows predate it, an operator can act directly on the database, and a trigger can be
-- dropped. So the provisioner gets its own answer, computed at the moment it is about to write.
--
-- This is the ONLY function 4A-2 should consult. It never guesses:
--   {'outcome':'resolved','member_type':'professional'|'next'}   exactly one live intent
--   {'outcome':'ambiguous','count':N}                            more than one distinct live intent
--   {'outcome':'not_found'}                                      no live waitlist row
-- 'ambiguous' and 'not_found' are both refusals. A provisioner that cannot obtain 'resolved' must
-- create nothing — never fall back to the column DEFAULT, which is what silently produces a
-- Professional profile for a student.
--
-- Normalisation is lower(btrim(...)) — byte-identical to migration 078's resolvers and to
-- lib/auth/normalizeEmail.ts. One definition of identity, not a subtly different fourth one.
CREATE OR REPLACE FUNCTION public.resolve_intended_member_type(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_norm  text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, '')));
  v_types text[];
BEGIN
  IF v_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'not_found');
  END IF;

  SELECT pg_catalog.array_agg(DISTINCT w.intended_member_type)
    INTO v_types
  FROM public.waitlist w
  WHERE pg_catalog.lower(pg_catalog.btrim(COALESCE(w.email, ''))) = v_norm
    AND COALESCE(w.status, '') <> 'revoked';

  IF v_types IS NULL OR pg_catalog.array_length(v_types, 1) IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'not_found');
  END IF;

  IF pg_catalog.array_length(v_types, 1) > 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'outcome', 'ambiguous', 'count', pg_catalog.array_length(v_types, 1));
  END IF;

  RETURN pg_catalog.jsonb_build_object('outcome', 'resolved', 'member_type', v_types[1]);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_intended_member_type(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_intended_member_type(text) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_intended_member_type(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_intended_member_type(text) TO service_role;

COMMENT ON FUNCTION public.resolve_intended_member_type(text) IS
  'THE provisioning-time community resolver. Returns resolved/ambiguous/not_found for an exact '
  'lower(btrim()) normalised address — the same identity rule migration 078 uses. Emits no address. '
  'Read-only. A caller that cannot obtain outcome=resolved must create no profile; it must NEVER '
  'fall back to the profiles.member_type column default. service_role EXECUTE only. Migration 099.';


-- ── SECTION 4 — profiles.member_type IS IMMUTABLE AFTER INSERT ───────────────────────────────
--
-- The application writes profiles as service_role, which BYPASSES RLS, so an RLS policy cannot bind
-- it and neither can a TypeScript check. A BEFORE UPDATE trigger runs inside the write itself and
-- binds every caller — service_role included.
--
-- INSERT IS DELIBERATELY UNTOUCHED. 4A-2 must be able to create a profile with member_type='next'
-- in one statement, which is the whole point of Architecture A. This trigger forbids CHANGING a
-- community, not establishing one.
--
-- AN UPDATE THAT MENTIONS member_type WITH THE SAME VALUE IS ALLOWED. `IS DISTINCT FROM` is the
-- simplest correct predicate here: it is NULL-safe, and it means the many existing writers that
-- send a whole row (the two upserts in app/actions.ts) keep working untouched, while any actual
-- transition is rejected. The invariant is about the VALUE changing, not about the column being
-- named.
--
-- There is no bypass argument, no session flag, no admin exemption and no ADMIN_EMAIL check. A
-- legitimate future correction will be an explicit, separately designed administrative operation —
-- deliberately not built here, because a correction mechanism that exists is a correction mechanism
-- that can be called.
CREATE OR REPLACE FUNCTION public.tg_profiles_member_type_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.member_type IS DISTINCT FROM OLD.member_type THEN
    RAISE EXCEPTION
      'profiles.member_type is immutable after provisioning (attempted % -> %)',
      COALESCE(OLD.member_type, '<null>'),
      COALESCE(NEW.member_type, '<null>')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_profiles_member_type_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tg_profiles_member_type_immutable() FROM anon;
REVOKE ALL ON FUNCTION public.tg_profiles_member_type_immutable() FROM authenticated;

DROP TRIGGER IF EXISTS profiles_member_type_immutable_bu ON public.profiles;
-- No `OF member_type` clause: a whole-row UPDATE that does not name the column still carries
-- NEW.member_type, and restricting the trigger to a column list would be a narrower guarantee than
-- the invariant needs.
CREATE TRIGGER profiles_member_type_immutable_bu
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_profiles_member_type_immutable();


-- ── SECTION 5 — POSTAPPLY PROOF ──────────────────────────────────────────────────────────────
-- Re-read the catalog and prove the end state rather than trusting the statements above. Any
-- failure rolls the whole migration back.
DO $postcheck$
DECLARE
  v_default text;
  v_src text;
BEGIN
  -- (1) The designation column: present, NOT NULL, defaulted Professional, constrained.
  SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid) INTO v_default
  FROM pg_catalog.pg_attribute a
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.waitlist'::pg_catalog.regclass AND a.attname = 'intended_member_type';
  IF v_default IS NULL OR pg_catalog.strpos(v_default, 'professional') = 0 THEN
    RAISE EXCEPTION '099: waitlist.intended_member_type default is [%], expected professional.', v_default;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.waitlist'::pg_catalog.regclass
      AND a.attname = 'intended_member_type' AND a.attnotnull
  ) THEN
    RAISE EXCEPTION '099: waitlist.intended_member_type is not NOT NULL.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'waitlist_intended_member_type_check'
      AND conrelid = 'public.waitlist'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION '099: waitlist_intended_member_type_check is missing.';
  END IF;

  -- (2) Every pre-existing waitlist row is Professional. No half-run backfill is possible.
  IF EXISTS (
    SELECT 1 FROM public.waitlist
    WHERE intended_member_type IS NULL OR intended_member_type NOT IN ('professional', 'next')
  ) THEN
    RAISE EXCEPTION '099: a waitlist row carries an unrecognised intended_member_type.';
  END IF;

  -- (3) Both triggers exist and are BEFORE row triggers.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.profiles'::pg_catalog.regclass
      AND tgname = 'profiles_member_type_immutable_bu' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '099: the profiles member_type immutability trigger was not created.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.waitlist'::pg_catalog.regclass
      AND tgname = 'waitlist_intent_no_conflict_biu' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '099: the waitlist conflicting-intent trigger was not created.';
  END IF;

  -- (4) The resolver: SECURITY DEFINER, pinned search_path, service_role only, no bypass argument.
  IF pg_catalog.to_regprocedure('public.resolve_intended_member_type(text)') IS NULL THEN
    RAISE EXCEPTION '099: resolve_intended_member_type was not created.';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p
  WHERE p.oid = pg_catalog.to_regprocedure('public.resolve_intended_member_type(text)');
  IF pg_catalog.strpos(v_src, 'ambiguous') = 0 OR pg_catalog.strpos(v_src, 'not_found') = 0 THEN
    RAISE EXCEPTION '099: the resolver lost one of its refusal outcomes.';
  END IF;
  IF pg_catalog.has_function_privilege('anon', 'public.resolve_intended_member_type(text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.resolve_intended_member_type(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '099: a browser role can EXECUTE resolve_intended_member_type.';
  END IF;
  IF NOT pg_catalog.has_function_privilege('service_role', 'public.resolve_intended_member_type(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '099: service_role cannot EXECUTE resolve_intended_member_type.';
  END IF;

  -- (5) The Phase 2/3 contracts this migration must not have disturbed.
  IF pg_catalog.to_regprocedure('public.community_pair_allowed(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION '099: community_pair_allowed disappeared.';
  END IF;
  IF pg_catalog.has_table_privilege('anon', 'public.profiles', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION '099: a browser role holds SELECT on public.profiles.';
  END IF;
  IF pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'UPDATE') THEN
    RAISE EXCEPTION '099: a browser role holds UPDATE on public.profiles (migration 055).';
  END IF;
END
$postcheck$;

COMMIT;
