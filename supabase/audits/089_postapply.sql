-- 089 post-apply — read-only, one row.
WITH funcs(name,args) AS (VALUES
 ('reserve_credit_purchase','p_user_id uuid, p_price_id text, p_credits integer, p_expires_at timestamp with time zone'),
 ('bind_credit_purchase_reservation','p_reservation_id uuid, p_user_id uuid, p_session_id text, p_expires_at timestamp with time zone'),
 ('release_credit_purchase_reservation','p_reservation_id uuid, p_session_id text, p_reason text'),
 ('grant_reserved_credit_pack','p_reservation_id uuid, p_event_id text, p_session_id text, p_user_id uuid, p_price_id text, p_credits integer, p_amount_total integer, p_currency text'),
 ('apply_credit_refill','p_user_id uuid, p_cycle_on date, p_lease_token uuid')
), fn AS (
 SELECT f.name,
        count(p.oid)=1 AS exists_once,
        bool_and(p.prosecdef) AS security_definer,
        bool_and('search_path=""'=ANY(COALESCE(p.proconfig,ARRAY[]::text[]))) AS empty_search_path,
        bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE')) AS anon_blocked,
        bool_and(NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) AS authenticated_blocked,
        bool_and(has_function_privilege('service_role',p.oid,'EXECUTE')) AS service_allowed
 FROM funcs f LEFT JOIN pg_catalog.pg_proc p ON p.proname=f.name
   AND pg_get_function_arguments(p.oid)=f.args
   AND EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.oid=p.pronamespace AND n.nspname='public')
 GROUP BY f.name
)
SELECT pg_catalog.jsonb_pretty(pg_catalog.jsonb_build_object(
 'audit','089_postapply',
 'overall_verdict',CASE WHEN
   to_regclass('public.credit_purchase_reservations') IS NOT NULL
   AND (SELECT count(*)=5 AND bool_and(exists_once AND security_definer AND empty_search_path
       AND anon_blocked AND authenticated_blocked AND service_allowed) FROM fn)
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.meeting_credits'::regclass
              AND tgname='enforce_credit_capacity' AND tgenabled<>'D' AND NOT tgisinternal)
   AND NOT has_table_privilege('anon','public.credit_purchase_reservations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
   AND NOT has_table_privilege('authenticated','public.credit_purchase_reservations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
   AND has_table_privilege('service_role','public.credit_purchase_reservations','SELECT,INSERT,UPDATE')
   AND NOT EXISTS(SELECT 1 FROM public.meeting_credits WHERE COALESCE(balance,0)>50)
   AND NOT EXISTS(SELECT 1 FROM public.meeting_credits
                  WHERE COALESCE(balance,0)<>COALESCE(free_credits,0)+COALESCE(premium_credits,0))
   THEN 'PASS' ELSE 'FAIL' END,
 'functions',(SELECT jsonb_agg(to_jsonb(fn) ORDER BY name) FROM fn),
 'schema',pg_catalog.jsonb_build_object(
   'reservation_table',to_regclass('public.credit_purchase_reservations') IS NOT NULL,
   'rls_enabled',(SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='public.credit_purchase_reservations'::regclass),
   'rls_policies',(SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid='public.credit_purchase_reservations'::regclass),
   'active_partial_index',EXISTS(SELECT 1 FROM pg_catalog.pg_indexes WHERE schemaname='public'
     AND indexname='credit_purchase_reservations_active_user_idx' AND indexdef LIKE '%status = ''reserved''%'),
   'capacity_trigger',EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid='public.meeting_credits'::regclass
     AND tgname='enforce_credit_capacity' AND tgenabled<>'D' AND NOT tgisinternal),
   'combined_cap_constraint',EXISTS(SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid='public.meeting_credits'::regclass AND conname='meeting_credits_combined_cap' AND convalidated)
 ),
 'unchanged_on_apply',pg_catalog.jsonb_build_object(
   'reservations',(SELECT count(*) FROM public.credit_purchase_reservations),
   'balance_drift',(SELECT count(*) FROM public.meeting_credits
      WHERE COALESCE(balance,0)<>COALESCE(free_credits,0)+COALESCE(premium_credits,0)),
   'combined_over_50',(SELECT count(*) FROM public.meeting_credits WHERE COALESCE(balance,0)>50)
 ),
 'checked_at',pg_catalog.now()
)) AS postapply_089;
