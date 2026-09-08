import json,sys,re
sys.path.insert(0,'/tmp/p3gen')
B=json.load(open('/tmp/p3gen/bodies.json'))
MIG={"create_reciprocal_suggestion":"093_reciprocal_deficit_model",
"place_batch_rows":"085_unavailable_target_release","promote_queued_rows":"085_unavailable_target_release",
"materialize_admin_pair":"085_unavailable_target_release",
"finalize_mutual_match_atomic":"067_finalize_mutual_match_atomic",
"consume_credits_and_create_match":"087_credit_spend_order_and_meeting_credits_acl"}
ok=True
for fn,d in B.items():
    src=open("supabase/migrations/%s.sql"%MIG[fn],encoding="utf-8").read()
    recon = d["header"] + "\nAS " + d["tag"] + "\n" + d["body"] + "\n" + d["tag"] + ";"
    if recon not in src:
        print("  ROUND-TRIP FAIL", fn); ok=False
    else:
        print("  round-trip byte-identical: %-34s (%d chars)" % (fn, len(recon)))
print("ALL ROUND-TRIPS OK" if ok else "FAILURES PRESENT")
