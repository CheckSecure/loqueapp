-- 064_fixture.sql — review-batch tables for the migration 064 harness.
--
-- Loaded AFTER supabase/tests/063_fixture.sql. It adds only the two review-side tables, which are
-- not created by any migration (they predate the migrations directory) and so are transcribed from
-- the production catalog audit: column names, types, nullability, defaults, foreign keys and the
-- score_bucket CHECK are copied from that audit, not inferred.
--
-- Note what is DELIBERATELY absent, because production does not have it either: no unique
-- constraint on intro_requests(requester_id, target_user_id) and no self-pair CHECK. The harness
-- must be able to reproduce duplicate and self rows, or it would prove idempotency that the real
-- schema does not enforce.

-- The 063 fixture's profiles table predates the same-company recheck, which migration 064 adds.
-- Production profiles has `company`; add it here so the harness exercises that gate for real.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS company text;

CREATE TABLE IF NOT EXISTS public.introduction_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_number          integer NOT NULL,
  week_start            date NOT NULL,
  week_end              date NOT NULL,
  status                text DEFAULT 'active',
  created_by            uuid REFERENCES public.profiles(id),
  created_at            timestamptz DEFAULT now(),
  algorithm_version     text,
  scoring_model_version text,
  algorithm_config      jsonb,
  config_hash           text
);

CREATE TABLE IF NOT EXISTS public.batch_suggestions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        uuid REFERENCES public.introduction_batches(id) ON DELETE CASCADE,
  recipient_id    uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  suggested_id    uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  reason          text,
  match_score     numeric(6,2),
  position        integer DEFAULT 1,
  created_at      timestamptz DEFAULT now(),
  status          text DEFAULT 'active',
  shown_at        timestamptz,
  score_bucket    text CHECK (score_bucket IN ('high_score','mid_score','low_score')),
  dropped_at      timestamptz,
  materialized_at timestamptz
);

CREATE INDEX IF NOT EXISTS batch_suggestions_batch_id_idx  ON public.batch_suggestions (batch_id);
CREATE INDEX IF NOT EXISTS batch_suggestions_recipient_idx ON public.batch_suggestions (recipient_id);

-- Extend the 063 reset helper so the harness can truncate review state too.
CREATE OR REPLACE FUNCTION public.t_reset064() RETURNS void LANGUAGE sql AS $$
  TRUNCATE public.batch_suggestions, public.introduction_batches CASCADE;
  SELECT public.t_reset();
$$;
