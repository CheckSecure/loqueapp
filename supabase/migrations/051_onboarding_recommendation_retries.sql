-- 051 — Durable, narrowly-scoped retry queue for onboarding reciprocal recommendations.
-- Additive, idempotent, non-destructive. Applying it changes NO behavior until the deployed code
-- enqueues a retryable onboarding outcome and the worker cron claims it.
--
-- PRIVACY / SECURITY: service-role ONLY (RLS enabled, NO policies). Stores ONLY a per-member coarse
-- status + timing — never candidate identity, scores, profile data, email, names, error payloads,
-- tokens, or request bodies. The RPCs are SECURITY DEFINER with a hardened empty search_path; every
-- FUNCTION/OBJECT reference is schema-qualified (GREATEST/LEAST/COALESCE are SQL grammar keywords,
-- not catalog functions, so they are correctly unqualified and unaffected by search_path). EXECUTE is
-- revoked from PUBLIC/anon/authenticated and granted only to service_role. Claim is atomic
-- (FOR UPDATE SKIP LOCKED) — never a select-then-update race.

CREATE TABLE IF NOT EXISTS public.onboarding_recommendation_retries (
  user_id           uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','processing','completed','terminal')),
  reason            text NOT NULL
                      CHECK (reason IN ('capacity','empty_pool','no_compatible_candidate','transient_error')),
  attempt_count     integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 1000),
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_attempt_at   timestamptz NULL,
  lease_expires_at  timestamptz NULL,
  last_outcome      text NULL,
  -- Immutable row creation/audit time.
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Start of the CURRENT retry cycle; drives the MAX_AGE (14-day) exhaustion policy. Reset ONLY when
  -- a completed/terminal row is explicitly resurrected by a NEW failure — never on ordinary upserts.
  cycle_started_at  timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- Lease invariant (bidirectional): a lease exists IFF the job is being processed. Prevents both a
  -- leaseless-processing row (never reclaimable) and a stale lease on a settled row.
  CONSTRAINT onboarding_retries_lease_matches_status
    CHECK (
      (status = 'processing' AND lease_expires_at IS NOT NULL)
      OR
      (status <> 'processing' AND lease_expires_at IS NULL)
    )
);

ALTER TABLE public.onboarding_recommendation_retries ENABLE ROW LEVEL SECURITY; -- service-role only; NO policies
REVOKE ALL ON public.onboarding_recommendation_retries FROM PUBLIC, anon, authenticated;

-- Idempotent add for a pre-existing table from an earlier draft (safe if the column already exists).
ALTER TABLE public.onboarding_recommendation_retries
  ADD COLUMN IF NOT EXISTS cycle_started_at timestamptz NOT NULL DEFAULT now();

COMMENT ON TABLE public.onboarding_recommendation_retries IS
  'Service-role only per-member onboarding reciprocal-recommendation retry queue. Coarse status + timing only. One row per member (PK).';

-- Claim scan: due pending jobs (+ expired-lease processing jobs) ordered by schedule.
CREATE INDEX IF NOT EXISTS onboarding_retries_due_idx
  ON public.onboarding_recommendation_retries (next_attempt_at)
  WHERE status IN ('pending','processing');

-- ── Atomic enqueue (upsert) ──────────────────────────────────────────────────────────
-- One row per member. Two distinct semantics:
--   • Ordinary enqueue into an ACTIVE (pending/processing) cycle → keeps attempt_count,
--     next_attempt_at, cycle_started_at, and lease untouched (only reason/last_outcome refresh), so
--     it can NEVER reset attempts, restart the age clock, or accelerate an already-scheduled job.
--   • A NEW explicit retryable failure that resurrects a completed/terminal row → starts a FRESH
--     cycle: status→pending, attempt_count→0, cycle_started_at→now(), a new next_attempt_at, lease→NULL.
-- p_reason is allow-listed (RAISE + table CHECK); p_backoff_seconds is clamped to [0, 604800] (7 days,
-- NULL→0) so no value can overflow make_interval or place a job arbitrarily far in the future.
CREATE OR REPLACE FUNCTION public.enqueue_onboarding_retry(
  p_user_id uuid,
  p_reason text,
  p_backoff_seconds integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_backoff integer := LEAST(GREATEST(COALESCE(p_backoff_seconds, 0), 0), 604800);
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'enqueue_onboarding_retry: p_user_id must not be null';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('capacity','empty_pool','no_compatible_candidate','transient_error') THEN
    RAISE EXCEPTION 'enqueue_onboarding_retry: invalid reason';
  END IF;

  INSERT INTO public.onboarding_recommendation_retries
    (user_id, status, reason, attempt_count, next_attempt_at, last_outcome,
     created_at, cycle_started_at, updated_at, lease_expires_at)
  VALUES
    (p_user_id, 'pending', p_reason, 0,
     pg_catalog.now() + pg_catalog.make_interval(secs => v_backoff),
     p_reason, pg_catalog.now(), pg_catalog.now(), pg_catalog.now(), NULL)
  ON CONFLICT (user_id) DO UPDATE SET
    reason = EXCLUDED.reason,
    last_outcome = EXCLUDED.last_outcome,
    updated_at = pg_catalog.now(),
    -- created_at is DELIBERATELY immutable (audit only).
    status = CASE WHEN public.onboarding_recommendation_retries.status IN ('completed','terminal')
                  THEN 'pending' ELSE public.onboarding_recommendation_retries.status END,
    attempt_count = CASE WHEN public.onboarding_recommendation_retries.status IN ('completed','terminal')
                        THEN 0 ELSE public.onboarding_recommendation_retries.attempt_count END,
    cycle_started_at = CASE WHEN public.onboarding_recommendation_retries.status IN ('completed','terminal')
                          THEN pg_catalog.now() ELSE public.onboarding_recommendation_retries.cycle_started_at END,
    next_attempt_at = CASE WHEN public.onboarding_recommendation_retries.status IN ('completed','terminal')
                          THEN pg_catalog.now() + pg_catalog.make_interval(secs => v_backoff)
                          ELSE public.onboarding_recommendation_retries.next_attempt_at END,
    lease_expires_at = CASE WHEN public.onboarding_recommendation_retries.status IN ('completed','terminal')
                          THEN NULL ELSE public.onboarding_recommendation_retries.lease_expires_at END;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_onboarding_retry(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_onboarding_retry(uuid, text, integer) TO service_role;

-- ── Atomic claim + lease ─────────────────────────────────────────────────────────────
-- Claims at most a CLAMPED limit of due jobs (pending & due, OR processing whose lease expired →
-- safe reclaim), flips them to 'processing' with a BOUNDED lease, and returns them. FOR UPDATE SKIP
-- LOCKED so concurrent workers can NEVER claim the same member. p_limit is clamped to [0,20]
-- (NULL → 0) and p_lease_seconds to [1,3600] (NULL → 1) — unsafe/null values can never remove the
-- cap or set an unbounded lease. Never a select-then-update; completed/terminal jobs are excluded.
CREATE OR REPLACE FUNCTION public.claim_onboarding_retries(
  p_limit integer,
  p_lease_seconds integer
) RETURNS SETOF public.onboarding_recommendation_retries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.onboarding_recommendation_retries r
  SET status = 'processing',
      lease_expires_at = pg_catalog.now()
        + pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 1), 1), 3600)),
      updated_at = pg_catalog.now()
  WHERE r.user_id IN (
    SELECT c.user_id
    FROM public.onboarding_recommendation_retries c
    WHERE (c.status = 'pending' AND c.next_attempt_at <= pg_catalog.now())
       OR (c.status = 'processing' AND c.lease_expires_at IS NOT NULL AND c.lease_expires_at < pg_catalog.now())
    ORDER BY c.next_attempt_at ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 0), 0), 20)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING r.*;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_onboarding_retries(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_onboarding_retries(integer, integer) TO service_role;
