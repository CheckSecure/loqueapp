-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 086 — RELEASE B: LEAST PRIVILEGE ON THE CONNECTION-GRAPH TABLES
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- WHY. public.matches and public.blocked_users still grant SELECT to `authenticated`, and no
-- migration ever created an RLS policy on either. Migration 055 revoked only INSERT/UPDATE/DELETE.
-- Any logged-in member could therefore read the entire social graph as UUID pairs straight from
-- PostgREST. Release A (commit 42052b66671a04a0fd1d7937948d88ab2d5467ec) moved all nine
-- application readers onto service_role so this revoke breaks nothing.
--
-- ─── WHAT IT DOES, EXHAUSTIVELY ───────────────────────────────────────────────────────────────
--   PUBLIC / anon / authenticated  → every TABLE privilege revoked, every COLUMN privilege revoked
--   service_role                   → reset, then granted exactly SELECT, INSERT, UPDATE, DELETE
--   owner (postgres)               → untouched
--
-- ─── WHY COLUMN GRANTS ARE REVOKED SEPARATELY ─────────────────────────────────────────────────
-- REVOKE ALL PRIVILEGES ON TABLE does NOT remove column-level grants. A leftover
-- GRANT SELECT (user_a_id) would keep the graph readable after a table-level revoke that looks
-- complete. Section 2 therefore walks pg_attribute and revokes per column, dynamically, so the
-- migration covers whatever columns the table actually has rather than a list frozen at authoring
-- time. Those EXECUTEs are DCL only — there is no DML anywhere in this file.
--
-- ─── MAINTAIN ─────────────────────────────────────────────────────────────────────────────────
-- PostgreSQL 17 added the MAINTAIN privilege. Rather than name it (which would fail to parse on
-- 16 and below), every revoke uses ALL PRIVILEGES, which removes every privilege type the running
-- server knows about — including MAINTAIN where it exists. The postcondition then asserts the
-- resulting ACL is empty, so a future privilege type cannot silently survive either.
--
-- ─── WHAT IT DOES NOT TOUCH ───────────────────────────────────────────────────────────────────
-- No row is inserted, updated, deleted, truncated or backfilled. Ownership, RLS enabled/forced
-- state, policies, constraints, indexes, triggers, sequences, functions, match statuses and block
-- rows are all left exactly as found — and the postconditions prove it by comparing snapshots
-- taken before the first revoke.
--
-- Transactional and FAIL-CLOSED: every assertion RAISEs, which aborts the transaction and rolls
-- the whole migration back. Idempotent: re-running is a no-op that still passes every assertion.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── SECTION 0 — PRECONDITIONS + SNAPSHOT ─────────────────────────────────────────────────────
DO $precheck$
DECLARE
  r          record;
  v_missing  text;
BEGIN
  -- Both tables must exist, as ordinary tables.
  FOR r IN SELECT * FROM (VALUES ('matches'), ('blocked_users')) AS t(name) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = r.name AND c.relkind = 'r'
    ) THEN
      RAISE EXCEPTION '086 REFUSED: public.% is missing or is not an ordinary table.', r.name;
    END IF;
  END LOOP;

  -- Every role this migration names must exist, so a typo or an unexpected environment fails with
  -- a clear message instead of a bare "role does not exist" from a REVOKE.
  SELECT pg_catalog.string_agg(x.rolname, ', ') INTO v_missing
  FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS x(rolname)
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles p WHERE p.rolname = x.rolname);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '086 REFUSED: expected role(s) not present: %.', v_missing;
  END IF;

  -- Snapshot everything the postconditions must prove unchanged. A temp table is session-local
  -- metadata, not application data: it touches no public schema object and disappears at COMMIT.
  CREATE TEMP TABLE _m086_before ON COMMIT DROP AS
  SELECT c.relname,
         c.relowner,
         c.relrowsecurity,
         c.relforcerowsecurity,
         (SELECT count(*) FROM pg_catalog.pg_policy p  WHERE p.polrelid  = c.oid) AS n_policies,
         (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid = c.oid) AS n_constraints,
         (SELECT count(*) FROM pg_catalog.pg_index i    WHERE i.indrelid  = c.oid) AS n_indexes,
         (SELECT count(*) FROM pg_catalog.pg_trigger g  WHERE g.tgrelid   = c.oid
                                                          AND NOT g.tgisinternal)  AS n_triggers,
         (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.pg_get_expr(p.polqual, p.polrelid)
                          || '|' || COALESCE(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), ''),
                          E'\n' ORDER BY p.polname), '')
            FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid)                  AS policy_text,
         c.oid AS reloid
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('matches', 'blocked_users');

  -- Row counts, captured so the postcondition can prove nothing was written.
  CREATE TEMP TABLE _m086_counts ON COMMIT DROP AS
  SELECT 'matches'::text AS relname, (SELECT count(*) FROM public.matches) AS n
  UNION ALL
  SELECT 'blocked_users', (SELECT count(*) FROM public.blocked_users);

  RAISE NOTICE '086 preconditions passed: both tables present, all roles present, snapshot taken.';
END
$precheck$;

-- ── SECTION 1 — TABLE-LEVEL PRIVILEGES: BROWSER ROLES ────────────────────────────────────────
-- PUBLIC is the pseudo-role keyword and is deliberately unquoted. ALL PRIVILEGES covers SELECT,
-- INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and (on 17+) MAINTAIN.
REVOKE ALL PRIVILEGES ON TABLE public.matches       FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.matches       FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.matches       FROM authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.blocked_users FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.blocked_users FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.blocked_users FROM authenticated;

-- ── SECTION 2 — COLUMN-LEVEL PRIVILEGES ──────────────────────────────────────────────────────
-- Table-level REVOKE leaves these behind. Walk the CURRENT columns of both tables and revoke from
-- every browser role, plus from service_role so no column grant can conflict with or widen the
-- table-level authority granted in section 3. DCL only.
DO $columns$
DECLARE
  r      record;
  v_role text;
BEGIN
  FOR r IN
    SELECT c.relname, a.attname
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relname IN ('matches', 'blocked_users')
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum
  LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL (%I) ON TABLE public.%I FROM %I', r.attname, r.relname, v_role);
    END LOOP;
    -- PUBLIC is a keyword, never an identifier: it must not go through %I.
    EXECUTE pg_catalog.format(
      'REVOKE ALL (%I) ON TABLE public.%I FROM PUBLIC', r.attname, r.relname);
  END LOOP;
  RAISE NOTICE '086 column-level grants revoked for PUBLIC, anon, authenticated, service_role.';
END
$columns$;

-- ── SECTION 3 — service_role: RESET, THEN EXACTLY FOUR ───────────────────────────────────────
REVOKE ALL PRIVILEGES ON TABLE public.matches       FROM service_role;
REVOKE ALL PRIVILEGES ON TABLE public.blocked_users FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.matches       TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.blocked_users TO service_role;

-- ── SECTION 4 — POSTCONDITIONS (fail closed → the whole migration rolls back) ─────────────────
DO $verify$
DECLARE
  r        record;
  v_privs  text;
  v_n      bigint;
  v_before record;
  c_priv   constant text[] :=
    ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'];
  p        text;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('matches'), ('blocked_users')) AS t(name) LOOP

    -- 4a. Browser roles hold NOTHING at table level. has_table_privilege is used because it also
    -- accounts for privileges inherited via PUBLIC, which aclexplode alone would not show.
    FOREACH p IN ARRAY c_priv LOOP
      IF pg_catalog.has_table_privilege('anon', ('public.' || r.name)::regclass, p) THEN
        RAISE EXCEPTION '086 FAILED: anon still holds % on public.%.', p, r.name;
      END IF;
      IF pg_catalog.has_table_privilege('authenticated', ('public.' || r.name)::regclass, p) THEN
        RAISE EXCEPTION '086 FAILED: authenticated still holds % on public.%.', p, r.name;
      END IF;
    END LOOP;

    -- 4b. No ACL entry naming PUBLIC, anon or authenticated survives — at table OR column level.
    -- This is the check that catches a privilege type this migration did not think to name.
    SELECT pg_catalog.string_agg(DISTINCT x.privilege_type, ',') INTO v_privs
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) x
    WHERE n.nspname = 'public' AND c.relname = r.name
      AND (x.grantee = 0
        OR x.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon')
        OR x.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'));
    IF v_privs IS NOT NULL THEN
      RAISE EXCEPTION
        '086 FAILED: browser-role table ACL entries remain on public.%: %.', r.name, v_privs;
    END IF;

    -- EXPLICIT column grants live in pg_attribute.attacl. information_schema.column_privileges is
    -- NOT usable here: it reports a TABLE-level grant as one row per column, so a correct
    -- service_role table grant would look like dozens of phantom column grants.
    SELECT count(*) INTO v_n
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
    WHERE n.nspname = 'public' AND c.relname = r.name
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
      AND (x.grantee = 0
        OR x.grantee IN (SELECT oid FROM pg_catalog.pg_roles
                          WHERE rolname IN ('anon', 'authenticated')));
    IF v_n <> 0 THEN
      RAISE EXCEPTION '086 FAILED: % column grant(s) remain for browser roles on public.%.',
        v_n, r.name;
    END IF;

    -- 4c. service_role holds EXACTLY the four DML privileges — no more, no fewer.
    FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE'] LOOP
      IF NOT pg_catalog.has_table_privilege('service_role', ('public.' || r.name)::regclass, p) THEN
        RAISE EXCEPTION '086 FAILED: service_role lost % on public.%.', p, r.name;
      END IF;
    END LOOP;
    FOREACH p IN ARRAY ARRAY['TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF pg_catalog.has_table_privilege('service_role', ('public.' || r.name)::regclass, p) THEN
        RAISE EXCEPTION '086 FAILED: service_role still holds % on public.%.', p, r.name;
      END IF;
    END LOOP;

    -- 4d. service_role has no residual COLUMN grants that could widen or conflict.
    SELECT count(*) INTO v_n
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
    WHERE n.nspname = 'public' AND c.relname = r.name
      AND a.attnum > 0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
      AND x.grantee = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role');
    IF v_n <> 0 THEN
      RAISE EXCEPTION '086 FAILED: % residual service_role column grant(s) on public.%.',
        v_n, r.name;
    END IF;

    -- 4e. Nothing structural moved, and the table was not recreated (same oid).
    SELECT * INTO v_before FROM _m086_before b WHERE b.relname = r.name;
    IF v_before.reloid <> ('public.' || r.name)::regclass::oid THEN
      RAISE EXCEPTION '086 FAILED: public.% was recreated (oid changed).', r.name;
    END IF;
    IF (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = v_before.reloid)
         <> v_before.relowner THEN
      RAISE EXCEPTION '086 FAILED: ownership of public.% changed.', r.name;
    END IF;
    IF (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid = v_before.reloid)
         IS DISTINCT FROM v_before.relrowsecurity
       OR (SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c WHERE c.oid = v_before.reloid)
         IS DISTINCT FROM v_before.relforcerowsecurity THEN
      RAISE EXCEPTION '086 FAILED: RLS enabled/forced state of public.% changed.', r.name;
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid = v_before.reloid)
         <> v_before.n_policies THEN
      RAISE EXCEPTION '086 FAILED: policy count on public.% changed.', r.name;
    END IF;
    IF (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.pg_get_expr(p.polqual, p.polrelid)
                        || '|' || COALESCE(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), ''),
                        E'\n' ORDER BY p.polname), '')
          FROM pg_catalog.pg_policy p WHERE p.polrelid = v_before.reloid)
         IS DISTINCT FROM v_before.policy_text THEN
      RAISE EXCEPTION '086 FAILED: policy definitions on public.% changed.', r.name;
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid = v_before.reloid)
         <> v_before.n_constraints THEN
      RAISE EXCEPTION '086 FAILED: constraint count on public.% changed.', r.name;
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_index i WHERE i.indrelid = v_before.reloid)
         <> v_before.n_indexes THEN
      RAISE EXCEPTION '086 FAILED: index count on public.% changed.', r.name;
    END IF;
    IF (SELECT count(*) FROM pg_catalog.pg_trigger g
         WHERE g.tgrelid = v_before.reloid AND NOT g.tgisinternal) <> v_before.n_triggers THEN
      RAISE EXCEPTION '086 FAILED: trigger count on public.% changed.', r.name;
    END IF;
  END LOOP;

  -- 4f. NOT ONE ROW WAS WRITTEN. This migration performs no DML; the assertion makes that
  -- provable rather than merely intended.
  IF (SELECT count(*) FROM public.matches) <> (SELECT n FROM _m086_counts WHERE relname = 'matches')
  THEN RAISE EXCEPTION '086 FAILED: public.matches row count changed.'; END IF;
  IF (SELECT count(*) FROM public.blocked_users)
       <> (SELECT n FROM _m086_counts WHERE relname = 'blocked_users')
  THEN RAISE EXCEPTION '086 FAILED: public.blocked_users row count changed.'; END IF;

  RAISE NOTICE '086 APPLIED: PUBLIC/anon/authenticated hold nothing on either graph table; '
               'service_role holds exactly SELECT, INSERT, UPDATE, DELETE; owner, RLS, policies, '
               'constraints, indexes, triggers and row counts unchanged.';
END
$verify$;

COMMIT;
