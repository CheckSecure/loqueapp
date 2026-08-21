-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PREFLIGHT FOR MIGRATION 074 — weekly batch release evidence
-- STRICTLY READ-ONLY. One statement, SELECT + CTEs. Aggregate/structural only; no identifiers.
-- verdict: OK / BLOCKER / REVIEW / INFO.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
WITH rows_out(sort, section, check_name, observed, expected) AS (VALUES
  (1, 'A. 074 objects must be ABSENT', 'table weekly_batch_releases',
      (to_regclass('public.weekly_batch_releases') IS NOT NULL)::text, 'false'),
  (1, 'A. 074 objects must be ABSENT', 'index weekly_batch_releases_key_uniq',
      (to_regclass('public.weekly_batch_releases_key_uniq') IS NOT NULL)::text, 'false'),
  (1, 'A. 074 objects must be ABSENT', 'function weekly_batch_released(text)',
      (to_regprocedure('public.weekly_batch_released(text)') IS NOT NULL)::text, 'false'),
  (1, 'A. 074 objects must be ABSENT', 'type name collision',
      (EXISTS (SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
               WHERE n.nspname='public' AND t.typname='weekly_batch_releases'))::text, 'false'),

  (2, 'B. prerequisites', 'introduction_batches exists (provenance reference)',
      (to_regclass('public.introduction_batches') IS NOT NULL)::text, 'true'),
  (2, 'B. prerequisites', 'gen_random_uuid() is available',
      (to_regprocedure('gen_random_uuid()') IS NOT NULL)::text, 'true'),
  -- 074 adds NO column to introduction_batches; confirm nothing already claims to be a release marker
  (2, 'B. prerequisites', 'introduction_batches has NO released_at column',
      (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
               AND table_name='introduction_batches' AND column_name='released_at'))::text, 'false'),
  (2, 'B. prerequisites', 'introduction_batches has NO approved_at column',
      (EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
               AND table_name='introduction_batches' AND column_name='approved_at'))::text, 'false'),

  (3, 'C. context (no backfill is performed)', 'introduction_batches rows with status active',
      (SELECT count(*)::text FROM public.introduction_batches WHERE status='active'), 'context'),
  (3, 'C. context (no backfill is performed)', 'introduction_batches rows, all time',
      (SELECT count(*)::text FROM public.introduction_batches), 'context'),
  (3, 'C. context (no backfill is performed)', 'currently visible suggested cards',
      (SELECT count(*)::text FROM public.intro_requests WHERE status='suggested'), 'context')
)
SELECT section, check_name, observed, expected,
       CASE WHEN expected='context' THEN 'INFO'
            WHEN observed=expected  THEN 'OK'
            WHEN section LIKE 'A.%' THEN 'REVIEW'
            ELSE 'BLOCKER' END AS verdict
FROM rows_out ORDER BY sort, check_name;
