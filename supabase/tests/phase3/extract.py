import re, json, sys

# fn -> (authoritative migration, must-contain markers, must-NOT-contain markers)
SPECS = [
 ("create_reciprocal_suggestion","093_reciprocal_deficit_model",
    ["p_release_id","exists_active","member_pairs","c_max_visible"], ["placed'","p_rows"]),
 ("place_batch_rows","085_unavailable_target_release",
    ["p_rows","'placed'","admin_reciprocal"], ["exists_active"]),
 ("promote_queued_rows","085_unavailable_target_release",
    ["queued","recommendation_batches"], ["p_rows"]),
 ("materialize_admin_pair","085_unavailable_target_release",
    ["batch_suggestions","proposal_not_symmetric","p_review_batch_id"], ["p_rows"]),
 ("finalize_mutual_match_atomic","067_finalize_mutual_match_atomic",
    ["consume_credits_and_create_match","not_consented","consent_missing"], ["batch_suggestions"]),
 ("consume_credits_and_create_match","087_credit_spend_order_and_meeting_credits_acl",
    ["v_chargeable","insufficient_credits_a","credit_transactions"], ["p_rows"]),
]

def extract(fn, mig):
    src = open("supabase/migrations/%s.sql" % mig, encoding="utf-8").read()
    anchor = "CREATE OR REPLACE FUNCTION public.%s(" % fn
    if src.count(anchor) == 0:
        raise SystemExit("NO CREATE for %s in %s" % (fn, mig))
    start = src.rindex(anchor)                     # LAST definition in the file wins
    m = re.compile(r"\nAS (\$[A-Za-z_]*\$)\n").search(src, start)
    if not m: raise SystemExit("no body open tag for %s" % fn)
    tag = m.group(1); bo = m.end()
    close = "\n%s;" % tag
    bc = src.index(close, bo)
    header = src[start:m.start()]                   # signature + LANGUAGE/SECURITY/SET lines
    body = src[bo:bc]
    return {"fn":fn,"mig":mig,"tag":tag,"header":header,"body":body,
            "lines":body.count("\n"), "chars":len(body)}

out = {}
for fn, mig, must, mustnot in SPECS:
    d = extract(fn, mig)
    for mk in must:
        if mk not in d["body"]:
            raise SystemExit("IDENTITY FAIL %s: missing marker %r" % (fn, mk))
    for mk in mustnot:
        if mk in d["body"]:
            raise SystemExit("IDENTITY FAIL %s: foreign marker %r present" % (fn, mk))
    out[fn] = d
    print("OK  %-34s %-46s tag=%-10s %4d lines %6d chars" % (fn, mig, d["tag"], d["lines"], d["chars"]))
json.dump(out, open("/tmp/p3gen/bodies.json","w"))
