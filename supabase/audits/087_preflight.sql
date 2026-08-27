-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- 087 PREFLIGHT — CREDIT RELEASE 1. READ-ONLY. ONE statement. NO member identities.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Run before supabase/migrations/087_credit_spend_order_and_meeting_credits_acl.sql. Reports the
-- pre-state of the two things 087 changes — the spend authority and the meeting_credits ACL — plus
-- the balance drift that migration 088 and the reconciliation repair will address.
--
-- NO IDENTITIES. Counts, privilege bits, policy expressions and function-shape booleans only. No
-- user id, name, email or balance belonging to any individual is emitted.
--
-- ─── THE EXPECTED PRE-STATE IS PRODUCTION'S, NOT A FIXTURE'S ──────────────────────────────────
-- An earlier draft of this work reported a "before" posture of RLS-off / no-policies / PUBLIC
-- SELECT. That was a DISPOSABLE FIXTURE the author had built from an assumption, never an
-- observation. The production census reports the opposite: RLS is ENABLED (not forced), five
-- policies exist, anon / authenticated / service_role each hold all seven table privileges, there
-- is no PUBLIC ACL entry and no explicit column grant.
--
-- The expectations below are pinned to THAT observed state. The verdict BLOCKS on any drift —
-- an unexpected policy name, a missing one, or a privilege that no longer matches — because a
-- posture this migration did not anticipate is a posture it should not rewrite.
--
-- SQL CANNOT VERIFY WHICH COMMIT IS DEPLOYED. The admin Members reader swap is an operator
-- confirmation below, not something this file checks.
WITH
priv AS (
  SELECT r.rolname, p.priv, pg_catalog.has_table_privilege(r.rolname,'public.meeting_credits'::regclass,p.priv) AS held
  FROM (VALUES ('anon'),('authenticated'),('service_role')) r(rolname)
  CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
  WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles x WHERE x.rolname=r.rolname)
),
pub AS (
  SELECT COALESCE(pg_catalog.string_agg(DISTINCT x.privilege_type,',' ORDER BY x.privilege_type),'(none)') AS privs
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) x
  WHERE n.nspname='public' AND c.relname='meeting_credits' AND x.grantee=0
),
cols AS (
  SELECT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_catalog.pg_roles WHERE oid=x.grantee) END AS grantee,
         a.attname AS col, x.privilege_type AS priv
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
  CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x
  WHERE n.nspname='public' AND c.relname='meeting_credits' AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL
),
pol AS (
  SELECT policyname, permissive, roles::text AS applies_to, cmd,
         COALESCE(qual,'(none)') AS using_expr, COALESCE(with_check,'(none)') AS check_expr
  FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='meeting_credits'
),
-- The five policy names the production census reported. Migration 087 drops exactly these and
-- replaces them with one self-read SELECT policy. Their EXPRESSIONS are emitted in full above so
-- the operator can record what is being removed; only the NAME SET is pinned here, because the
-- expressions were not part of the reviewed census and pinning an unreviewed value would be
-- pretending to a certainty this file does not have.
expected_policies AS (
  SELECT ARRAY[
    'Only admins can delete credits',
    'Only admins can insert credits',
    'Only admins can update credits',
    'Users view own credits or admin views all',
    'credits_select_own'
  ]::text[] AS names
),
-- ── PINNED POLICY SEMANTICS ──────────────────────────────────────────────────────────────────
-- A NAME is not a policy. "Only admins can update credits" could be rewritten to
-- USING (true) and keep its name, and a name-only check would wave it through. These rows pin the
-- COMMAND, ROLE SET, USING and WITH CHECK of each of the five, and any difference is a BLOCKER.
--
-- THE EXPRESSIONS BELOW ARE THE OBSERVED PRODUCTION VALUES, returned by credit_state_census.sql
-- and supplied for this file. They are written in their RAW catalog form; the normaliser below is
-- applied to BOTH sides, so pasting what pg_policies printed is enough — no hand-normalisation.
--
-- Note what production actually says, which differs from what a reader might assume: the roles are
-- {public} (the policies were created with no TO clause), and the predicate is a call to
-- public.is_admin() rather than an inline EXISTS. Both are pinned exactly as found.
expected_semantics(policy, cmd, applies_to, using_expr, check_expr) AS (
  VALUES
    ('Only admins can delete credits',            'DELETE', '{public}', 'is_admin()',                          '(none)'),
    ('Only admins can insert credits',            'INSERT', '{public}', '(none)',                              'is_admin()'),
    ('Only admins can update credits',            'UPDATE', '{public}', 'is_admin()',                          '(none)'),
    ('Users view own credits or admin views all', 'SELECT', '{public}', '((auth.uid() = user_id) OR is_admin())', '(none)'),
    ('credits_select_own',                        'SELECT', '{public}', '(user_id = auth.uid())',              '(none)')
),
-- NORMALISATION. pg_get_expr re-prints an expression: it adds parentheses, expands `auth.uid()` to
-- `( SELECT auth.uid() AS uid)`, and varies whitespace. Those are FORMATTING differences and must
-- not be reported as semantic drift. Everything below collapses whitespace, drops the alias pg
-- appends to a scalar subselect, and removes spaces adjacent to punctuation. It does NOT lowercase
-- (identifier case can be meaningful) and does NOT strip parentheses that change grouping.
norm AS (
  SELECT
    p.policyname::text AS policy,
    upper(btrim(p.cmd))                                                       AS cmd_n,
    btrim(regexp_replace(p.applies_to, '\s+', '', 'g'))                       AS roles_n,
    btrim(regexp_replace(regexp_replace(regexp_replace(
      p.using_expr, '\s+AS\s+[a-z_][a-z0-9_]*', '', 'gi'),
      '\s+', ' ', 'g'), '\s*([(),])\s*', '\1', 'g'))                        AS using_n,
    btrim(regexp_replace(regexp_replace(regexp_replace(
      p.check_expr, '\s+AS\s+[a-z_][a-z0-9_]*', '', 'gi'),
      '\s+', ' ', 'g'), '\s*([(),])\s*', '\1', 'g'))                        AS check_n
  FROM pol p
),
expected_norm AS (
  SELECT
    e.policy,
    upper(btrim(e.cmd))                                                       AS cmd_n,
    btrim(regexp_replace(e.applies_to, '\s+', '', 'g'))                       AS roles_n,
    btrim(regexp_replace(regexp_replace(regexp_replace(
      e.using_expr, '\s+AS\s+[a-z_][a-z0-9_]*', '', 'gi'),
      '\s+', ' ', 'g'), '\s*([(),])\s*', '\1', 'g'))                        AS using_n,
    btrim(regexp_replace(regexp_replace(regexp_replace(
      e.check_expr, '\s+AS\s+[a-z_][a-z0-9_]*', '', 'gi'),
      '\s+', ' ', 'g'), '\s*([(),])\s*', '\1', 'g'))                        AS check_n,
    -- Retained as a guard: every value above is pinned today, so this is always false. If a
    -- future edit blanks one out, the verdict blocks instead of silently comparing against ''.
    (btrim(COALESCE(e.cmd,'')) = '' OR btrim(COALESCE(e.applies_to,'')) = ''
     OR btrim(COALESCE(e.using_expr,'')) = '' OR btrim(COALESCE(e.check_expr,'')) = '') AS unpinned
  FROM expected_semantics e
),
semantic_drift AS (
  SELECT
    COALESCE((SELECT pg_catalog.array_agg(x.policy ORDER BY x.policy)
              FROM expected_norm x WHERE x.unpinned), ARRAY[]::text[]) AS unpinned_policies,
    COALESCE((SELECT pg_catalog.array_agg(
                e.policy || ' [' ||
                pg_catalog.concat_ws(', ',
                  CASE WHEN n.cmd_n   IS DISTINCT FROM e.cmd_n   THEN 'command'    END,
                  CASE WHEN n.roles_n IS DISTINCT FROM e.roles_n THEN 'roles'      END,
                  CASE WHEN n.using_n IS DISTINCT FROM e.using_n THEN 'USING'      END,
                  CASE WHEN n.check_n IS DISTINCT FROM e.check_n THEN 'WITH CHECK' END)
                || ']' ORDER BY e.policy)
              FROM expected_norm e
              JOIN norm n ON n.policy = e.policy
              WHERE NOT e.unpinned
                AND (n.cmd_n   IS DISTINCT FROM e.cmd_n
                  OR n.roles_n IS DISTINCT FROM e.roles_n
                  OR n.using_n IS DISTINCT FROM e.using_n
                  OR n.check_n IS DISTINCT FROM e.check_n)), ARRAY[]::text[]) AS changed
),
policy_drift AS (
  SELECT
    -- Two traps here, both hit for real: pg_policies.policyname is `name`, not `text`; and
    -- `<> ALL ((SELECT arr FROM cte))` is parsed as a SUBQUERY comparison, not an array one, so it
    -- fails with "operator does not exist: text <> text[]". unnest() in FROM sidesteps both.
    COALESCE((SELECT pg_catalog.array_agg(p.policyname::text ORDER BY p.policyname) FROM pol p
               WHERE NOT EXISTS (
                 SELECT 1 FROM unnest((SELECT names FROM expected_policies)) AS n
                 WHERE n = p.policyname::text)), ARRAY[]::text[]) AS unexpected,
    COALESCE((SELECT pg_catalog.array_agg(n ORDER BY n)
               FROM unnest((SELECT names FROM expected_policies)) AS n
              WHERE n NOT IN (SELECT p2.policyname::text FROM pol p2)), ARRAY[]::text[]) AS missing
),
-- Observed production privilege posture: all seven, for all three roles.
priv_drift AS (
  SELECT
    COALESCE((SELECT pg_catalog.array_agg(rolname || ':' || priv ORDER BY rolname, priv)
              FROM priv WHERE NOT held), ARRAY[]::text[]) AS not_held_but_expected
),
drift AS (
  SELECT count(*) AS rows_total,
    count(*) FILTER (WHERE COALESCE(balance,0) <> COALESCE(free_credits,0)+COALESCE(premium_credits,0)) AS drifted,
    COALESCE(max(abs(COALESCE(balance,0)-(COALESCE(free_credits,0)+COALESCE(premium_credits,0)))),0) AS max_drift,
    count(*) FILTER (WHERE COALESCE(free_credits,0)<0) AS neg_free,
    count(*) FILTER (WHERE COALESCE(premium_credits,0)<0) AS neg_premium,
    count(*) FILTER (WHERE COALESCE(balance,0)<0) AS neg_balance,
    count(*) FILTER (WHERE COALESCE(premium_credits,0)>0 AND COALESCE(free_credits,0)=0) AS premium_only_members
  FROM public.meeting_credits
),
spend AS (
  SELECT p.prosrc AS src, p.prosecdef AS secdef, pg_catalog.array_to_string(p.proconfig,',') AS cfg
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='consume_credits_and_create_match' LIMIT 1
)
SELECT jsonb_pretty(jsonb_build_object(
  'generated_at', now(),
  'server_version', current_setting('server_version'),
  'meeting_credits_acl', jsonb_build_object(
    'owner', (SELECT r.rolname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
              JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND c.relname='meeting_credits'),
    'rls_enabled', (SELECT c.relrowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relname='meeting_credits'),
    'rls_forced', (SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='public' AND c.relname='meeting_credits'),
    'PUBLIC', (SELECT privs FROM pub),
    'effective_table_privileges', COALESCE((SELECT jsonb_object_agg(rolname, privs) FROM (
       SELECT rolname, COALESCE(pg_catalog.string_agg(priv,',' ORDER BY priv) FILTER (WHERE held),'(none)') AS privs
       FROM priv GROUP BY rolname) a), '{}'::jsonb),
    'explicit_column_grants', COALESCE((SELECT jsonb_agg(jsonb_build_object('grantee',grantee,'column',col,'privilege',priv) ORDER BY grantee,col) FROM cols), '[]'::jsonb),
    'policy_count', (SELECT count(*) FROM pol),
    'policies', COALESCE((SELECT jsonb_agg(jsonb_build_object('policy',policyname,'permissive',permissive,
       'applies_to',applies_to,'command',cmd,'using',using_expr,'with_check',check_expr) ORDER BY policyname) FROM pol), '[]'::jsonb)),
  'spend_authority', (SELECT jsonb_build_object(
      'present', src IS NOT NULL,
      'security_definer', secdef, 'search_path_config', COALESCE(cfg,'(none)'),
      'references_premium_credits', src LIKE '%premium_credits%',
      'free_only_predicate_present', src LIKE '%AND free_credits >= 1%',
      'locks_rows_for_update', src LIKE '%FOR UPDATE%',
      'reads_is_admin_for_share', src LIKE '%FOR SHARE%',
      'writes_ledger', src LIKE '%credit_transactions%',
      'records_funded_from', src LIKE '%funded_from%') FROM spend),
  'balance_state', (SELECT to_jsonb(d) FROM drift d),
  'invariant_constraints', jsonb_build_object(
    'balance_invariant_present', EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='meeting_credits_balance_invariant'),
    'buckets_non_negative_present', EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname='meeting_credits_buckets_non_negative')),
  'ledger_by_source_and_bucket', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'source_kind', COALESCE(source_kind,'(unset)'), 'funded_from', COALESCE(funded_from,'(null)'),
      'amount', amount, 'events', n) ORDER BY 1,2)
    -- funded_from ARRIVES WITH 087. Read through to_jsonb so this preflight, which runs BEFORE
    -- the migration, yields NULL for the column instead of raising "column does not exist".
    FROM (SELECT t.source_kind, (to_jsonb(t) ->> 'funded_from') AS funded_from, t.amount, count(*) n
          FROM public.credit_transactions t GROUP BY 1,2,3) a), '[]'::jsonb),
  'expected_pre_state_from_production_census', jsonb_build_object(
    'rls_enabled', true, 'rls_forced', false, 'policy_count', 5,
    'policy_names', (SELECT names FROM expected_policies),
    'anon', 'all seven table privileges',
    'authenticated', 'all seven table privileges',
    'service_role', 'all seven table privileges',
    'public_acl', '(none)', 'explicit_column_grants', 0,
    'source', 'production credit_state_census result, operator-supplied'),
  'policy_semantics', jsonb_build_object(
    'unpinned', (SELECT unpinned_policies FROM semantic_drift),
    'changed',  (SELECT changed FROM semantic_drift),
    'normalised_observed', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'policy', policy, 'command', cmd_n, 'roles', roles_n,
        'using', using_n, 'with_check', check_n) ORDER BY policy) FROM norm), '[]'::jsonb),
    'note', 'These are the observed values after normalisation, for comparison with the pinned '
         || 'expectations. Normalisation '
         || 'collapses whitespace, drops the alias pg_get_expr appends to a scalar subselect, and '
         || 'removes spaces around punctuation. It does not lowercase and does not strip grouping '
         || 'parentheses, so a real semantic change cannot be normalised away.'),
  'drift_from_expected', jsonb_build_object(
    'unexpected_policies', (SELECT unexpected FROM policy_drift),
    'missing_expected_policies', (SELECT missing FROM policy_drift),
    'expected_privileges_not_held', (SELECT not_held_but_expected FROM priv_drift),
    'public_acl_unexpectedly_present', (SELECT privs <> '(none)' FROM pub),
    'explicit_column_grants_unexpectedly_present', EXISTS (SELECT 1 FROM cols),
    'rls_unexpectedly_disabled', NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='meeting_credits'),
    'rls_unexpectedly_forced', (SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='meeting_credits')),
  'operator_confirmation_required', jsonb_build_array(
    'SQL CANNOT CHECK THESE. Confirm before applying 087:',
    '1. RELEASE 1A IS DEPLOYED — and ONLY 1A. That is app/dashboard/admin/members/page.tsx (the '
      || 'credits read moved to createAdminClient) plus its tests. It reads the whole table with no '
      || 'user_id filter; the own-row policy 087 creates would otherwise reduce it to the '
      || 'administrator''s own row and every other member''s credit column would silently read 0.',
    '2. RELEASE 1B IS *NOT* YET DEPLOYED. app/actions.ts calls public.admin_adjust_credits, which '
      || 'THIS MIGRATION CREATES. Deploying it before 087 would leave the admin credit control '
      || 'raising "function does not exist" for the whole window. 1B ships immediately AFTER the '
      || 'post-apply audit passes.',
    '3. BETWEEN 087 AND 1B: DO NOT USE THE ADMIN CREDIT-ADJUSTMENT CONTROL. The old server action '
      || 'still works — service_role keeps SELECT/INSERT/UPDATE — but it writes `balance` alone and '
      || 'would re-drift the invariant that the reconciliation repair is about to fix. The window is '
      || 'minutes; simply do not touch that control until 1B is live.',
    '4. Migrations 072 and 073 are applied (the precondition block in 087 also checks this).',
    '5. RECORD the five policy expressions printed in meeting_credits_acl.policies. 087 DROPS all '
      || 'five. They were created out of band — no migration in this repository authored them — so '
      || 'this output is the only record of what they said.'),
  'verdict', CASE
    WHEN to_regclass('public.meeting_credits') IS NULL THEN 'BLOCKER: meeting_credits is missing'
    WHEN pg_catalog.array_length((SELECT unexpected FROM policy_drift), 1) > 0
      THEN 'BLOCKER: unexpected polic(ies) on meeting_credits: '
           || pg_catalog.array_to_string((SELECT unexpected FROM policy_drift), ', ')
           || '. 087 drops five NAMED policies; it will not remove one it has not seen reviewed.'
    WHEN pg_catalog.array_length((SELECT missing FROM policy_drift), 1) > 0
      THEN 'BLOCKER: expected polic(ies) absent: '
           || pg_catalog.array_to_string((SELECT missing FROM policy_drift), ', ')
           || '. The posture has changed since the census — re-review before applying.'
    WHEN pg_catalog.array_length((SELECT unpinned_policies FROM semantic_drift), 1) > 0
      THEN 'BLOCKER: policy SEMANTICS are not pinned for: '
           || pg_catalog.array_to_string((SELECT unpinned_policies FROM semantic_drift), ', ')
           || '. A value in expected_semantics was blanked. A name-only check would pass a policy '
           || 'rewritten to USING (true), so this refuses rather than degrading to one.'
    WHEN pg_catalog.array_length((SELECT changed FROM semantic_drift), 1) > 0
      THEN 'BLOCKER: policy SEMANTICS changed since the census: '
           || pg_catalog.array_to_string((SELECT changed FROM semantic_drift), '; ')
           || '. 087 drops these policies; what it drops must be what was reviewed.'
    WHEN pg_catalog.array_length((SELECT not_held_but_expected FROM priv_drift), 1) > 0
      THEN 'BLOCKER: privilege drift — expected-but-not-held: '
           || pg_catalog.array_to_string((SELECT not_held_but_expected FROM priv_drift), ', ')
    WHEN (SELECT privs FROM pub) <> '(none)' THEN 'BLOCKER: a PUBLIC ACL entry appeared'
    WHEN EXISTS (SELECT 1 FROM cols) THEN 'BLOCKER: an explicit column grant appeared'
    WHEN (SELECT c.relforcerowsecurity FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname='meeting_credits')
      THEN 'BLOCKER: RLS is FORCED, which the reviewed posture was not'
    WHEN NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                     AND table_name='credit_transactions' AND column_name='event_key')
      THEN 'BLOCKER: migration 072 is not applied'
    WHEN (SELECT src FROM spend) IS NULL THEN 'BLOCKER: the spend function is missing'
    WHEN (SELECT src FROM spend) NOT LIKE '%AND free_credits >= 1%'
      THEN 'ALREADY APPLIED: the free-only predicate is gone; 087 would be a no-op'
    ELSE 'READY (database side) — proceed after the operator confirmations above' END,
  'record_before_applying', jsonb_build_array(
    'Copy balance_state. The reconciliation repair pins drifted=11 and max_drift=1 and REFUSES if '
      || 'production no longer matches; the post-apply and post-repair audits compare against what '
      || 'you record here.')
)) AS preflight_087;
