-- 056 — Durable, atomic rate-limit counter (server/service-role only).
--
-- WHY: issue reports (and future abuse-prone endpoints) need a per-user rate limit that survives process
-- restarts and is race-free under concurrent console calls. A read-then-insert in app code is neither.
-- This provides a single-statement atomic increment (INSERT ... ON CONFLICT DO UPDATE ... RETURNING)
-- keyed by (bucket_key, window_start), callable ONLY by service_role from authorized server code.
--
-- Additive, idempotent, re-runnable. No browser access (RLS on + no policies; EXECUTE service_role only).

CREATE TABLE IF NOT EXISTS public.rate_limit_hits (
  bucket_key   text        NOT NULL,   -- e.g. 'issue_report:<user_uuid>'
  window_start timestamptz NOT NULL,   -- start of the fixed window this hit falls in
  hits         integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);

ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;
-- No policies → unreachable by anon/authenticated via PostgREST. service_role bypasses RLS.
REVOKE ALL ON TABLE public.rate_limit_hits FROM PUBLIC, anon, authenticated;
GRANT  ALL ON TABLE public.rate_limit_hits TO service_role;

-- Atomic check-and-increment. Returns the new hit count for the current window. Opportunistically GCs
-- older windows for the same key so the table stays small. SECURITY DEFINER with an empty search_path;
-- all references schema-qualified (pg_catalog is always implicitly available for built-ins).
CREATE OR REPLACE FUNCTION public.bump_rate_limit(
  p_bucket_key   text,
  p_window_start timestamptz
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_hits integer;
BEGIN
  INSERT INTO public.rate_limit_hits (bucket_key, window_start, hits)
  VALUES (p_bucket_key, p_window_start, 1)
  ON CONFLICT (bucket_key, window_start)
  DO UPDATE SET hits = public.rate_limit_hits.hits + 1
  RETURNING hits INTO v_hits;

  DELETE FROM public.rate_limit_hits
  WHERE bucket_key = p_bucket_key
    AND window_start < p_window_start;

  RETURN v_hits;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_rate_limit(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_rate_limit(text, timestamptz) TO service_role;
