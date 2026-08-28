-- 089 preflight — read-only, one row.
SELECT pg_catalog.jsonb_pretty(pg_catalog.jsonb_build_object(
  'audit','089_preflight',
  'overall_verdict', CASE WHEN
    to_regclass('public.meeting_credits') IS NOT NULL
    AND to_regclass('public.credit_refills') IS NOT NULL
    AND to_regclass('public.credit_grants') IS NOT NULL
    AND to_regprocedure('public.apply_credit_refill(uuid,date,uuid)') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.meeting_credits WHERE COALESCE(balance,0)>50)
    AND NOT EXISTS (SELECT 1 FROM public.meeting_credits
                    WHERE COALESCE(balance,0)<>COALESCE(free_credits,0)+COALESCE(premium_credits,0))
    THEN 'READY' ELSE 'BLOCKED' END,
  'prerequisites',pg_catalog.jsonb_build_object(
    'meeting_credits',to_regclass('public.meeting_credits') IS NOT NULL,
    'credit_refills',to_regclass('public.credit_refills') IS NOT NULL,
    'credit_grants',to_regclass('public.credit_grants') IS NOT NULL,
    'apply_refill',to_regprocedure('public.apply_credit_refill(uuid,date,uuid)') IS NOT NULL
  ),
  'population',pg_catalog.jsonb_build_object(
    'balance_drift',(SELECT count(*) FROM public.meeting_credits
      WHERE COALESCE(balance,0)<>COALESCE(free_credits,0)+COALESCE(premium_credits,0)),
    'combined_over_50',(SELECT count(*) FROM public.meeting_credits WHERE COALESCE(balance,0)>50),
    'legacy_included_over_20',(SELECT count(*) FROM public.meeting_credits WHERE COALESCE(free_credits,0)>20),
    'note','legacy included balances above 20 are preserved; they receive zero included credits until they fall below 20'
  ),
  'existing_089_objects',pg_catalog.jsonb_build_object(
    'reservation_table',to_regclass('public.credit_purchase_reservations') IS NOT NULL,
    'reserve_function',to_regprocedure('public.reserve_credit_purchase(uuid,text,integer,timestamptz)') IS NOT NULL,
    'capacity_trigger',EXISTS(SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='public.meeting_credits'::regclass AND tgname='enforce_credit_capacity' AND NOT tgisinternal)
  ),
  'checked_at',pg_catalog.now()
)) AS preflight_089;
