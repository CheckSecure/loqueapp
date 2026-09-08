import json,sys
sys.path.insert(0,'/tmp/p3gen')
from guards import GUARDS
B=json.load(open('/tmp/p3gen/bodies.json'))
ORDER=["create_reciprocal_suggestion","place_batch_rows","promote_queued_rows",
       "materialize_admin_pair","finalize_mutual_match_atomic","consume_credits_and_create_match"]
MIG={"create_reciprocal_suggestion":"093","place_batch_rows":"085","promote_queued_rows":"085",
     "materialize_admin_pair":"085","finalize_mutual_match_atomic":"067",
     "consume_credits_and_create_match":"087"}

out=[open('/tmp/p3gen/header.sql').read()]
out.append("\n-- ── SECTION 1 — THE SIX AUTHORITATIVE WRITERS, RESTATED WITH THEIR COMMUNITY GUARD ──────────\n")
for fn in ORDER:
    d=B[fn]; body=d["body"]
    for old,new in GUARDS[fn]:
        assert body.count(old)==1, (fn,"anchor not unique")
        body=body.replace(old,new)
    assert "community_pair_allowed" in body, fn
    out.append("\n-- ---- %s  (body from migration %s, %d original lines) ----\n"%(fn,MIG[fn],d["lines"]))
    out.append(d["header"]+"\nAS "+d["tag"]+"\n"+body+"\n"+d["tag"]+";\n")
out.append(open('/tmp/p3gen/newfns.sql').read())

# ---- postapply integrity proof -------------------------------------------------------------
markers={
 "create_reciprocal_suggestion":["exists_active","member_pairs","p_release_id"],
 "place_batch_rows":["p_rows","admin_reciprocal","recommendation_batches"],
 "promote_queued_rows":["deferred_capacity","empty_queued_batch"],
 "materialize_admin_pair":["proposal_not_symmetric","batch_suggestions","p_review_batch_id"],
 "finalize_mutual_match_atomic":["consume_credits_and_create_match","consent_missing"],
 "consume_credits_and_create_match":["v_chargeable","insufficient_credits_a","credit_transactions"],
}
sigs={
 "create_reciprocal_suggestion":"public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer, uuid)",
 "place_batch_rows":"public.place_batch_rows(uuid, text, jsonb, uuid, integer)",
 "promote_queued_rows":"public.promote_queued_rows(uuid)",
 "materialize_admin_pair":"public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer)",
 "finalize_mutual_match_atomic":"public.finalize_mutual_match_atomic(uuid, uuid, boolean)",
 "consume_credits_and_create_match":"public.consume_credits_and_create_match(uuid, uuid, boolean)",
}
rets={"create_reciprocal_suggestion":"text","place_batch_rows":"jsonb","promote_queued_rows":"jsonb",
      "materialize_admin_pair":"jsonb","finalize_mutual_match_atomic":"jsonb",
      "consume_credits_and_create_match":"record"}
rows=[]
for fn in ORDER:
    ms=", ".join("'%s'"%m.replace("'","''") for m in markers[fn])
    rows.append("    ('%s', '%s', '%s', ARRAY[%s])"%(fn,sigs[fn],rets[fn],ms))
post = r"""

-- ── SECTION 4 — POSTAPPLY INTEGRITY PROOF ────────────────────────────────────────────────────
-- Restating a 400-line function to add four lines is exactly the operation where a truncated or
-- mis-sourced body ships unnoticed. This block re-reads pg_proc and proves, for every replaced
-- function: it exists under the SAME signature, is still SECURITY DEFINER with a pinned empty
-- search_path, still returns the SAME type, is still unreachable from anon/authenticated, now
-- contains community_pair_allowed, AND still contains distinctive markers from its ORIGINAL body.
-- The marker check is the one that catches accidental replacement: a truncated or wrong-function
-- body loses them. Any failure RAISEs and rolls the entire migration back.
DO $postcheck$
DECLARE
  r record;
  v_src text;
  v_secdef boolean;
  v_cfg text;
  v_ret text;
  m text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
@@ROWS@@
    ) AS t(fname, sig, rettype, markers)
  LOOP
    IF pg_catalog.to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION '096: % is missing after replacement (signature changed?).', r.sig;
    END IF;

    SELECT p.prosrc, p.prosecdef,
           COALESCE(pg_catalog.array_to_string(p.proconfig, ','), '(none)'),
           pg_catalog.format_type(p.prorettype, NULL)
      INTO v_src, v_secdef, v_cfg, v_ret
    FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(r.sig);

    IF NOT v_secdef THEN
      RAISE EXCEPTION '096: % is no longer SECURITY DEFINER.', r.fname;
    END IF;
    IF v_cfg NOT IN ('search_path=', 'search_path=""') THEN
      RAISE EXCEPTION '096: % has a mutable search_path (%).', r.fname, v_cfg;
    END IF;
    IF v_ret <> r.rettype THEN
      RAISE EXCEPTION '096: % return type is %, expected %.', r.fname, v_ret, r.rettype;
    END IF;
    IF pg_catalog.strpos(v_src, 'community_pair_allowed') = 0 THEN
      RAISE EXCEPTION '096: % does not contain the community guard.', r.fname;
    END IF;
    FOREACH m IN ARRAY r.markers LOOP
      IF pg_catalog.strpos(v_src, m) = 0 THEN
        RAISE EXCEPTION '096: % lost original marker % — body was truncated or replaced.', r.fname, m;
      END IF;
    END LOOP;
    IF pg_catalog.has_function_privilege('anon', r.sig, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '096: a browser role can EXECUTE %.', r.fname;
    END IF;
  END LOOP;

  -- The sealed delegate: migration 068 revoked EXECUTE from service_role too, leaving the definer
  -- wrapper as its only caller. CREATE OR REPLACE preserves privileges, so this asserts that.
  IF pg_catalog.has_function_privilege('service_role',
       'public.consume_credits_and_create_match(uuid, uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '096: consume_credits_and_create_match is no longer sealed from service_role.';
  END IF;

  -- The two new primitives.
  FOR r IN SELECT * FROM (VALUES
      ('public.create_gated_match(uuid, uuid, boolean, text, text, timestamptz, boolean, uuid, jsonb)'),
      ('public.create_support_match(uuid, uuid, text)')
    ) AS t(sig)
  LOOP
    IF pg_catalog.to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION '096: % was not created.', r.sig;
    END IF;
    IF pg_catalog.has_function_privilege('anon', r.sig, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '096: a browser role can EXECUTE %.', r.sig;
    END IF;
    IF NOT pg_catalog.has_function_privilege('service_role', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION '096: service_role cannot EXECUTE %.', r.sig;
    END IF;
  END LOOP;

  -- community_pair_allowed must be untouched by this migration.
  IF pg_catalog.has_function_privilege('anon', 'public.community_pair_allowed(uuid, uuid)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', 'public.community_pair_allowed(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '096: community_pair_allowed became browser-executable.';
  END IF;

  -- And 058's contract still holds.
  IF pg_catalog.has_table_privilege('anon', 'public.profiles', 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', 'public.profiles', 'SELECT') THEN
    RAISE EXCEPTION '096: a browser role holds SELECT on public.profiles.';
  END IF;
END
$postcheck$;

COMMIT;
""".replace("@@ROWS@@", ",\n".join(rows))
out.append(post)
open('supabase/migrations/096_community_boundary_enforcement.sql','w').write("".join(out))
print("096 written")
