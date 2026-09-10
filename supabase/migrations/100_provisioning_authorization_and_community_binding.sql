-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 100 — PROVISIONING AUTHORIZATION AND COMMUNITY BINDING (Phase 4A-2)
--
-- Migration 099 installed the guardrails. This one makes them bind: after it applies, a profile row
-- can only come into existence for an identity that holds a live invitation, and the community it is
-- born into is derived from that invitation rather than from a column default.
--
-- ─── THE DEFAULT IS THE VULNERABILITY ─────────────────────────────────────────────────────────
-- profiles.member_type has carried NOT NULL DEFAULT 'professional' since 095. Column defaults are
-- computed BEFORE row triggers run — which is why 053's enroll_membership_credit_cycle can read
-- NEW.created_at — so while that default exists NO trigger can tell "the caller omitted the column"
-- from "the caller asked for Professional". Dropping it is therefore not tidying: it is what makes
-- omission mean "derive from the invitation" instead of "silently Professional". SECTION 4 drops it
-- in the SAME TRANSACTION as the trigger, because either half alone is a broken state — the trigger
-- without the drop cannot distinguish intent, and the drop without the trigger fails every insert.
--
-- ─── TWO QUESTIONS, TWO FUNCTIONS, NEVER COLLAPSED ────────────────────────────────────────────
--   resolve_intended_member_type(email)          WHICH community?    (099)
--   may_provision_profile(email, auth_user_id)   MAY a profile be created at all?   (here)
--
-- They must not be merged, and the reason is measurable rather than aesthetic. 099's resolver
-- excludes only status='revoked', so a waitlist row that is 'pending', 'approved', 'contacted' or
-- 'declined' still resolves to a community. Production holds exactly such rows. If the resolver were
-- also used as the authorization gate, anyone sitting on the public waitlist who obtained a session
-- could create themselves a profile. may_provision_profile therefore tests POSITIVELY for exactly
-- one 'invited' row and refuses everything else — never "not revoked".
--
-- ─── THE AUTHORIZATION RULE IS NOT NEW ────────────────────────────────────────────────────────
-- It is /api/profile/initialize's existing TypeScript predicate, lifted into the database where
-- service_role cannot step around it. Same two resolvers from 078, same lower(btrim()) identity,
-- same five conditions, same order. Lifting it matters because that route is UNREACHABLE from the
-- application — nothing fetches it — and the live first-profile writer is completeOnboarding, which
-- carries no invitation check at all. Until this migration, nothing enforced one.
--
-- ─── WHAT THIS FILE DOES NOT DO ───────────────────────────────────────────────────────────────
-- No admin bypass, no service_role bypass, no session flag, no override argument, no correction or
-- promotion mechanism, no mentorship or recruiting exception, no backfill, no data change. It
-- creates no Next member and designates nobody: waitlist.intended_member_type is untouched and every
-- production row still reads 'professional'. Migrations 095-099 are untouched.
--
-- ─── ONE NOTE FOR WHOEVER READS 095 NEXT ──────────────────────────────────────────────────────
-- Migration 095's postapply asserts that profiles.member_type HAS a default. That assertion was true
-- when it ran and is false afterwards, by design. 095 must not be re-applied after this migration.
-- Nothing re-applies migrations — scripts/check-migrations.ts only READS through the health probes —
-- but a human re-running 095 by hand would see it fail, and this is the explanation.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── SECTION 0 — PRECONDITIONS ────────────────────────────────────────────────────────────────
-- Everything this migration builds on, proved present before anything is created. Each check names
-- the migration that should have supplied the missing object.
DO $precheck$
BEGIN
  IF pg_catalog.to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION '100 REFUSED: public.profiles does not exist.';
  END IF;
  IF pg_catalog.to_regclass('public.waitlist') IS NULL THEN
    RAISE EXCEPTION '100 REFUSED: public.waitlist does not exist.';
  END IF;

  -- 078's identity resolvers. may_provision_profile is a composition of these two and must never
  -- grow a third notion of identity.
  IF pg_catalog.to_regprocedure('public.lookup_auth_identity(text)') IS NULL THEN
    RAISE EXCEPTION '100 REFUSED: lookup_auth_identity is absent — apply migration 078 first.';
  END IF;
  IF pg_catalog.to_regprocedure('public.lookup_waitlist_identity(text)') IS NULL THEN
    RAISE EXCEPTION '100 REFUSED: lookup_waitlist_identity is absent — apply migration 078 first.';
  END IF;

  -- 099's resolver and immutability trigger. Without the trigger, binding the community at INSERT
  -- would be pointless: any service_role UPDATE could move a member afterwards.
  IF pg_catalog.to_regprocedure('public.resolve_intended_member_type(text)') IS NULL THEN
    RAISE EXCEPTION '100 REFUSED: resolve_intended_member_type is absent — apply migration 099 first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.profiles'::pg_catalog.regclass
      AND tgname = 'profiles_member_type_immutable_bu' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '100 REFUSED: the 099 member_type immutability trigger is absent.';
  END IF;

  -- 095's column and its CHECK. This migration removes the DEFAULT and nothing else about it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.profiles'::pg_catalog.regclass
      AND a.attname = 'member_type' AND a.attnum > 0 AND NOT a.attisdropped AND a.attnotnull
  ) THEN
    RAISE EXCEPTION '100 REFUSED: profiles.member_type is absent or nullable — apply migration 095 first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'profiles_member_type_check'
      AND conrelid = 'public.profiles'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION '100 REFUSED: profiles_member_type_check is absent (migration 095).';
  END IF;

  -- A RULE or an inheritance child would route an INSERT around a row trigger entirely. Both are
  -- confirmed absent in production; assert it here so a future one cannot silently open a hole.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_rules
              WHERE schemaname = 'public' AND tablename = 'profiles') THEN
    RAISE EXCEPTION '100 REFUSED: public.profiles carries a RULE, which can bypass a row trigger.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_inherits
              WHERE inhparent = 'public.profiles'::pg_catalog.regclass) THEN
    RAISE EXCEPTION '100 REFUSED: public.profiles has an inheritance child; a parent trigger does not fire for it.';
  END IF;
END
$precheck$;


-- ── SECTION 1 — MAY THIS IDENTITY CREATE ITS FIRST PROFILE? ──────────────────────────────────
--
-- Returns {'outcome':'authorized'} or {'outcome':'refused','reason':'<code>'}.
--
-- THE REASON IS A CODE FROM A CLOSED VOCABULARY, NEVER FREE TEXT AND NEVER AN IDENTIFIER. This is
-- not decoration: completeOnboarding returns a failed write's message straight to the browser
-- (`return { error: error.message }`), so anything this function can say, a member can read. No
-- address, no user id, no waitlist id, no name, no row contents. Same rule 078 and 099 already
-- follow.
--
-- STABLE, not VOLATILE: it only reads. The transaction-scoped lock that serialises against a
-- concurrent revoke is taken by the TRIGGER, before this is called — a STABLE function may not
-- acquire row locks, and putting the lock here would also mean a plain diagnostic call took one.
--
-- The five conditions are /api/profile/initialize's, in its order, with its refusal semantics.
CREATE OR REPLACE FUNCTION public.may_provision_profile(p_email text, p_auth_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_norm    text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_email, '')));
  v_authn   integer;
  v_authid  uuid;
  v_total   integer;
  v_invited integer;
  v_invid   uuid;
  v_revoked boolean;
  v_decl    boolean;
  v_other   boolean;
BEGIN
  -- (a) An address we cannot normalise identifies nobody.
  IF v_norm = '' THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'no_email');
  END IF;
  IF p_auth_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'no_auth_user');
  END IF;

  -- (b) Exactly one auth identity. Two identities at one address is the ambiguous case
  -- sendSecureInvite already hard-stops on; zero means the account does not exist.
  SELECT li.identity_count, li.auth_user_id INTO v_authn, v_authid
    FROM public.lookup_auth_identity(v_norm) li;

  IF COALESCE(v_authn, 0) = 0 THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'identity_absent');
  END IF;
  IF v_authn > 1 OR v_authid IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'identity_ambiguous');
  END IF;

  -- (c) AND IT MUST BE THIS ONE. This is the condition that makes "create a profile for an
  -- arbitrary user id" unrepresentable rather than merely discouraged: the row's id has to BE the
  -- sole auth identity that owns the row's address. An admin cannot provision on someone's behalf
  -- without holding their identity, and no caller can mint a profile for a stranger.
  IF v_authid <> p_auth_user_id THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'identity_mismatch');
  END IF;

  -- (d)/(e)/(f) The invitation. POSITIVE test — exactly one row, and its status is exactly
  -- 'invited'. waitlist.status carries NO CHECK CONSTRAINT anywhere in migrations 001-099, so its
  -- vocabulary is enforced only in TypeScript and a value this code has never seen must fail closed.
  -- 'pending', 'approved' and 'contacted' are refused here even though 099's resolver would happily
  -- return a community for them, and that difference is the entire reason these are two functions.
  SELECT wi.total_rows, wi.invited_count, wi.invited_id,
         wi.has_revoked, wi.has_declined, wi.has_other_status
    INTO v_total, v_invited, v_invid, v_revoked, v_decl, v_other
    FROM public.lookup_waitlist_identity(v_norm) wi;

  IF COALESCE(v_total, 0) = 0 THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'waitlist_absent');
  END IF;
  IF v_total > 1 THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'waitlist_duplicate');
  END IF;
  IF COALESCE(v_invited, 0) <> 1 OR v_invid IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'waitlist_not_invited');
  END IF;
  -- Belt and braces given total_rows = 1: an address carrying a revoked, declined or unrecognised
  -- row is refused rather than resolved in favour of the permissive one.
  IF v_revoked OR v_decl OR v_other THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'waitlist_conflicting');
  END IF;

  RETURN pg_catalog.jsonb_build_object('outcome', 'authorized');
END;
$$;

REVOKE ALL ON FUNCTION public.may_provision_profile(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.may_provision_profile(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.may_provision_profile(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.may_provision_profile(text, uuid) TO service_role;

COMMENT ON FUNCTION public.may_provision_profile(text, uuid) IS
  'WHETHER an identity may create its first profile — never WHICH community, which is '
  'resolve_intended_member_type''s job. Requires exactly one auth identity, that it IS the supplied '
  'id, exactly one waitlist row, and that its status is exactly ''invited''. Positive test: a status '
  'this code has not seen fails closed. Emits a reason CODE only — completeOnboarding returns a '
  'failed write''s message to the browser, so this must never carry an address, id or name. '
  'service_role EXECUTE only. Migration 100.';


-- ── SECTION 2 — THE BINDING TRIGGER ──────────────────────────────────────────────────────────
--
-- VOLATILE (it takes a row lock) SECURITY DEFINER with a pinned search_path.
--
-- ─── STEP 0 IS NOT AN ESCAPE HATCH, IT IS A POSTGRESQL REQUIREMENT ────────────────────────────
-- BEFORE INSERT triggers fire for INSERT ... ON CONFLICT DO UPDATE *before* the conflict is
-- resolved, and both application writers are upserts. This is not theoretical here: 084's
-- stamp_intro_guidance_enrollment has been firing its INSERT branch on every completeOnboarding and
-- updateProfile upsert since 2026-08-25.
--
-- AND THE PROPOSED ROW IS CONSTRAINT-CHECKED EVEN WHEN IT IS DISCARDED. Measured on a disposable
-- cluster while designing this migration: a proposed row carrying NULL in a NOT NULL column raises
-- 23502 even though it conflicts and would have been excluded. So step 0 cannot simply `RETURN NEW`
-- and leave member_type NULL — once SECTION 4 drops the default, that would break EVERY existing
-- member's next profile edit. It assigns the row's CURRENT community, which is both valid and
-- correct: the value is not changing.
--
-- An explicit disagreement is refused rather than silently overwritten, so 099's immutability
-- guarantee holds on the INSERT branch of an upsert too, not only on the UPDATE that follows.
--
-- ─── WHY THE EXEMPTION IS KEYED ON id ALONE ───────────────────────────────────────────────────
-- Step 0b moved completeOnboarding from onConflict:'email' to onConflict:'id', so both writers now
-- conflict on the primary key and an email branch here would be a hole rather than a convenience: a
-- caller could carry someone else's address into the exemption. Keyed on id, this can only ever
-- exempt the caller's own existing row.
--
-- ─── THE LOCK, AND THE RACE IT ACTUALLY CLOSES ────────────────────────────────────────────────
-- An advisory lock was considered and rejected: the same-id and same-address races are already
-- closed by profiles_pkey and profiles_email_key, and an advisory lock the revoker never takes
-- cannot close the one race that remains. That race is a revoke committing between this statement's
-- snapshot and its write. FOR SHARE on the matching waitlist rows closes it properly, because
-- /api/admin/waitlist/revoke's UPDATE must then wait for this transaction. One row, and no deadlock
-- path: no writer locks profiles before waitlist.
CREATE OR REPLACE FUNCTION public.tg_profiles_provision_bind()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_norm     text := pg_catalog.lower(pg_catalog.btrim(COALESCE(NEW.email, '')));
  v_existing text;
  v_auth     jsonb;
  v_intent   jsonb;
  v_resolved text;
BEGIN
  -- ── STEP 0 — an upsert that will resolve to UPDATE. Keyed on the primary key only.
  SELECT p.member_type INTO v_existing
    FROM public.profiles p WHERE p.id = NEW.id;

  IF FOUND THEN
    IF NEW.member_type IS NOT NULL AND NEW.member_type IS DISTINCT FROM v_existing THEN
      RAISE EXCEPTION
        'profiles: provisioning refused (member_type_immutable_on_insert)'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Keep the row's own community. Not a bypass: the value is unchanged, the write ahead is an
    -- UPDATE, and 099's BEFORE UPDATE trigger is authoritative from here.
    NEW.member_type := v_existing;
    RETURN NEW;
  END IF;

  -- ── A GENUINELY NEW PROFILE FROM HERE ON ────────────────────────────────────────────────────

  -- ── STEP 1 — serialise against a concurrent revoke of this invitation.
  PERFORM 1 FROM public.waitlist w
   WHERE pg_catalog.lower(pg_catalog.btrim(COALESCE(w.email, ''))) = v_norm
   FOR SHARE;

  -- ── STEP 2 — WHETHER. Fail closed on anything but an explicit authorization.
  v_auth := public.may_provision_profile(NEW.email, NEW.id);
  IF COALESCE(v_auth ->> 'outcome', '') <> 'authorized' THEN
    RAISE EXCEPTION
      'profiles: provisioning refused (%)', COALESCE(v_auth ->> 'reason', 'unknown')
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── STEP 3 — WHICH. 'ambiguous' and 'not_found' are refusals, never a fallback.
  v_intent := public.resolve_intended_member_type(NEW.email);
  IF COALESCE(v_intent ->> 'outcome', '') <> 'resolved' THEN
    RAISE EXCEPTION
      'profiles: provisioning refused (intent_%)', COALESCE(v_intent ->> 'outcome', 'unknown')
      USING ERRCODE = 'check_violation';
  END IF;
  v_resolved := v_intent ->> 'member_type';

  -- ── STEP 4 — DERIVE, OR VALIDATE WHAT THE CALLER ASSERTED.
  -- Omitted (NULL, because SECTION 4 removes the default) means "use the invitation". A caller may
  -- state the same community redundantly; a caller that states a DIFFERENT one is refused. There is
  -- no third branch, so no path exists by which a request-borne value can win.
  IF NEW.member_type IS NULL THEN
    NEW.member_type := v_resolved;
  ELSIF NEW.member_type IS DISTINCT FROM v_resolved THEN
    RAISE EXCEPTION
      'profiles: provisioning refused (member_type_conflicts_with_invitation)'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.tg_profiles_provision_bind() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tg_profiles_provision_bind() FROM anon;
REVOKE ALL ON FUNCTION public.tg_profiles_provision_bind() FROM authenticated;

COMMENT ON FUNCTION public.tg_profiles_provision_bind() IS
  'THE profiles provisioning boundary. Exempts an upsert onto an existing id (assigning that row''s '
  'own member_type, because a discarded proposed row is still constraint-checked), and otherwise '
  'requires may_provision_profile=authorized and resolve_intended_member_type=resolved before '
  'deriving the community. No bypass of any kind. Migration 100.';


-- ── SECTION 3 — THE TRIGGER ──────────────────────────────────────────────────────────────────
-- NAMED TO FIRE FIRST. PostgreSQL runs same-kind BEFORE ROW triggers in name order, and the only
-- other BEFORE INSERT trigger on this table is stamp_intro_guidance_enrollment. 'p' sorts before
-- 's', so an unauthorized row is refused before anything else mutates NEW.
--
-- Ordering here is hygiene rather than correctness — tg_stamp_intro_guidance_enrollment mutates NEW
-- but never returns NULL, so it cannot suppress a later trigger, and a refusal aborts the statement
-- whichever order they run in. It is asserted from the catalog in SECTION 5 anyway, because a
-- security property that depends on a naming convention should not be left to the convention.
DROP TRIGGER IF EXISTS profiles_provision_bind_bi ON public.profiles;
CREATE TRIGGER profiles_provision_bind_bi
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_profiles_provision_bind();


-- ── SECTION 4 — REMOVE THE DEFAULT ───────────────────────────────────────────────────────────
-- The structural half. NOT NULL and profiles_member_type_check both remain: omission now yields
-- NULL at BEFORE INSERT time, the trigger fills it from the invitation, and NOT NULL catches any
-- path the trigger somehow did not reach.
ALTER TABLE public.profiles ALTER COLUMN member_type DROP DEFAULT;


-- ── SECTION 5 — POSTAPPLY PROOF ──────────────────────────────────────────────────────────────
-- Re-read the catalog and prove the end state rather than trusting the statements above. Any failure
-- rolls the whole migration back.
DO $postcheck$
DECLARE
  v_default text;
  v_order   text[];
  v_all     text[];
  v_refused bigint;
  v_total   bigint;
  v_next    bigint;
BEGIN
  -- (1) THE DEFAULT IS GONE, and nothing else about the column moved.
  SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid) INTO v_default
  FROM pg_catalog.pg_attribute a
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE a.attrelid = 'public.profiles'::pg_catalog.regclass AND a.attname = 'member_type';
  IF v_default IS NOT NULL THEN
    RAISE EXCEPTION '100: profiles.member_type still has a DEFAULT [%].', v_default;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.profiles'::pg_catalog.regclass
      AND a.attname = 'member_type' AND a.attnotnull
  ) THEN
    RAISE EXCEPTION '100: profiles.member_type lost NOT NULL.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'profiles_member_type_check'
      AND conrelid = 'public.profiles'::pg_catalog.regclass
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%professional%'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%next%'
  ) THEN
    RAISE EXCEPTION '100: profiles_member_type_check is missing or no longer names both communities.';
  END IF;

  -- (2) THE TRIGGER EXISTS AND FIRES FIRST. tgtype bits: 1=ROW, 2=BEFORE, 4=INSERT.
  --     COLLATE "C" so the assertion does not depend on the database collation.
  SELECT pg_catalog.array_agg(t.tgname ORDER BY t.tgname COLLATE "C") INTO v_order
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = 'public.profiles'::pg_catalog.regclass
    AND NOT t.tgisinternal
    AND (t.tgtype & 2) <> 0 AND (t.tgtype & 1) <> 0 AND (t.tgtype & 4) <> 0;

  IF v_order IS DISTINCT FROM ARRAY['profiles_provision_bind_bi', 'stamp_intro_guidance_enrollment'] THEN
    RAISE EXCEPTION '100: BEFORE INSERT ROW trigger order on profiles is [%], expected the binding trigger first.',
      pg_catalog.array_to_string(v_order, ', ');
  END IF;

  -- (3) THE WHOLE TOPOLOGY, so a future migration cannot drop one of these unnoticed.
  SELECT pg_catalog.array_agg(t.tgname ORDER BY t.tgname COLLATE "C") INTO v_all
  FROM pg_catalog.pg_trigger t
  WHERE t.tgrelid = 'public.profiles'::pg_catalog.regclass AND NOT t.tgisinternal;

  IF v_all IS DISTINCT FROM ARRAY[
       'capture_profile_deletion',
       'capture_profiles_truncate',
       'profiles_member_type_immutable_bu',
       'profiles_provision_bind_bi',
       'stamp_intro_guidance_enrollment',
       'trg_enroll_membership_credit_cycle'] THEN
    RAISE EXCEPTION '100: unexpected trigger topology on public.profiles: [%].',
      pg_catalog.array_to_string(v_all, ', ');
  END IF;

  -- (4) THE AUTHORIZER: present, and reachable by no browser role.
  IF pg_catalog.to_regprocedure('public.may_provision_profile(text, uuid)') IS NULL THEN
    RAISE EXCEPTION '100: may_provision_profile was not created.';
  END IF;
  IF pg_catalog.has_function_privilege('anon', 'public.may_provision_profile(text, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.may_provision_profile(text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '100: a browser role can EXECUTE may_provision_profile.';
  END IF;
  IF NOT pg_catalog.has_function_privilege('service_role', 'public.may_provision_profile(text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '100: service_role cannot EXECUTE may_provision_profile.';
  END IF;

  -- (5) THE 099 CONTRACTS THIS MIGRATION MUST NOT HAVE DISTURBED.
  IF pg_catalog.to_regprocedure('public.resolve_intended_member_type(text)') IS NULL THEN
    RAISE EXCEPTION '100: resolve_intended_member_type disappeared.';
  END IF;
  IF pg_catalog.has_function_privilege('anon', 'public.resolve_intended_member_type(text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.resolve_intended_member_type(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '100: a browser role can EXECUTE resolve_intended_member_type.';
  END IF;
  IF pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'UPDATE') THEN
    RAISE EXCEPTION '100: a browser role holds INSERT/UPDATE on public.profiles (migration 055).';
  END IF;

  -- (6) NO BYPASS VECTOR APPEARED WHILE THIS RAN.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_rules
              WHERE schemaname = 'public' AND tablename = 'profiles') THEN
    RAISE EXCEPTION '100: public.profiles carries a RULE.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_inherits
              WHERE inhparent = 'public.profiles'::pg_catalog.regclass) THEN
    RAISE EXCEPTION '100: public.profiles has an inheritance child.';
  END IF;

  -- (7) NO DATA CHANGED, AND NOBODY BECAME NEXT.
  SELECT count(*), count(*) FILTER (WHERE member_type = 'next') INTO v_total, v_next
  FROM public.profiles;
  IF v_next > 0 THEN
    RAISE EXCEPTION '100: % profiles are member_type=next; this migration designates nobody.', v_next;
  END IF;

  -- (8) HISTORICAL CENSUS — REPORTED, NEVER ENFORCED.
  -- How many existing profiles would be refused if they were inserted afresh today. Two are known
  -- from the Phase 4A audit: legacy identities predating the invitation architecture. They are
  -- legitimate history and are exempted by STEP 0 on every future write, so this must NOT fail the
  -- migration — a postapply that refused to apply because history exists would be exactly wrong.
  SELECT count(*) INTO v_refused
  FROM public.profiles p
  WHERE COALESCE(public.may_provision_profile(p.email, p.id) ->> 'outcome', '') <> 'authorized';

  RAISE NOTICE '100: % of % existing profiles would not be re-provisionable today (expected: the known legacy identities). They are unaffected: STEP 0 exempts every existing row.', v_refused, v_total;
END
$postcheck$;

COMMIT;
