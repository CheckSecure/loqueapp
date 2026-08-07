-- 046 — Presence privacy at the DATA boundary — EXPANSION half (zero-downtime).
--
-- PROBLEM: profiles.last_active_at was readable by any member who could read the profile
-- row (RLS is row-level, not column-level). Stripping it in the Network page is NOT
-- enforcement — an authenticated client could still SELECT last_active_at directly, even
-- for a member whose show_activity_status = false.
--
-- FIX (expand/contract): move the raw timestamp into a dedicated private table whose RLS
-- lets a member read/write ONLY their own row. Other members' presence is exposed SOLELY as
-- a coarse, privacy-filtered LABEL via the SECURITY DEFINER RPC below — the raw timestamp of
-- another member never leaves the database.
--
-- This EXPANSION migration is fully backward-compatible: it creates the new system and
-- backfills, but LEAVES profiles.last_active_at intact so the OLD code keeps working. The
-- legacy column is removed later by the separate CLEANUP migration 048, applied only after
-- the new application version is deployed and verified.
--
-- Prod-safe: idempotent (IF NOT EXISTS / CREATE OR REPLACE / guarded backfill). Non-destructive.

-- ── Private presence store ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.member_presence (
  user_id        uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  last_active_at timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.member_presence ENABLE ROW LEVEL SECURITY;

-- SELF-ONLY: a member may read and write ONLY their own presence row. There is NO policy
-- granting other-member SELECT, so a client can never read anyone else's raw timestamp.
-- (The service-role client bypasses RLS for system reads: digest, admin count, messages.)
DROP POLICY IF EXISTS member_presence_self_select ON public.member_presence;
CREATE POLICY member_presence_self_select ON public.member_presence
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS member_presence_self_insert ON public.member_presence;
CREATE POLICY member_presence_self_insert ON public.member_presence
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS member_presence_self_update ON public.member_presence;
CREATE POLICY member_presence_self_update ON public.member_presence
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ── Minimum TABLE privileges ───────────────────────────────────────────────────
-- RLS bounds WHICH ROWS a member touches, but the heartbeat runs under an AUTHENTICATED
-- session, so the table GRANTs must also be minimal. Revoke everything from PUBLIC/anon and
-- from authenticated (Supabase default-grants can be broad), then grant authenticated EXACTLY
-- SELECT/INSERT/UPDATE — the operations the self-only policies allow. No DELETE, TRUNCATE,
-- REFERENCES, or TRIGGER. The self-only RLS policies remain the actual row boundary. The
-- service-role client bypasses both grants and RLS, so system reads are unchanged.
REVOKE ALL ON TABLE public.member_presence FROM PUBLIC;
REVOKE ALL ON TABLE public.member_presence FROM anon;
REVOKE ALL ON TABLE public.member_presence FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.member_presence TO authenticated;

-- ── Coarse label helper (mirrors lib/presence/lastActive.ts formatLastActive) ──
-- Returns a privacy-conscious relative label, NEVER the raw timestamp. Calendar-day
-- comparisons use UTC so the label matches the TS formatter exactly (boundary-tested).
-- Hardened: explicit search_path 'pg_catalog, public' + fully schema-qualified references
-- so it cannot be subverted via caller-controlled object resolution.
CREATE OR REPLACE FUNCTION public._presence_label(ts timestamptz)
RETURNS text
LANGUAGE sql STABLE
SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN ts IS NULL THEN NULL
    WHEN now() - ts < interval '5 minutes'  THEN 'Online now'
    WHEN now() - ts < interval '60 minutes' THEN 'Active ' || floor(extract(epoch FROM now() - ts) / 60)::int   || 'm ago'
    WHEN now() - ts < interval '24 hours'   THEN 'Active ' || floor(extract(epoch FROM now() - ts) / 3600)::int || 'h ago'
    WHEN ((now() AT TIME ZONE 'UTC')::date - (ts AT TIME ZONE 'UTC')::date) <= 1 THEN 'Active yesterday'
    WHEN ((now() AT TIME ZONE 'UTC')::date - (ts AT TIME ZONE 'UTC')::date) < 7  THEN 'Active ' || ((now() AT TIME ZONE 'UTC')::date - (ts AT TIME ZONE 'UTC')::date)::int || 'd ago'
    ELSE NULL
  END;
$$;

-- ── The ONLY way another member's presence is exposed ──────────────────────────
-- SECURITY DEFINER so it can read member_presence + profiles regardless of RLS, but it
-- ENFORCES, in SQL: viewer authenticated (auth.uid()); a member always sees their own
-- status; any other member is returned ONLY when they are discoverable to the viewer AND
-- show_activity_status is not false. Output is a coarse LABEL (or null) — never a raw
-- timestamp. Hardened: explicit search_path 'pg_catalog, public' + schema-qualified tables
-- and functions (public.*, auth.uid, pg_catalog.unnest) so no object resolves via a
-- caller-controlled path.
CREATE OR REPLACE FUNCTION public.member_presence_labels(target_ids uuid[])
RETURNS TABLE (member_id uuid, label text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  viewer  uuid := auth.uid();
  max_ids constant int := 500; -- conservative bound for the Network page; excess is ignored
  ids     uuid[];
BEGIN
  IF viewer IS NULL THEN
    RETURN; -- anonymous callers receive nothing
  END IF;
  -- Bound + de-duplicate the input so an authenticated caller cannot force avoidable load
  -- with an arbitrarily large array: take at most the first max_ids elements, then DISTINCT.
  SELECT array_agg(DISTINCT x) INTO ids
  FROM pg_catalog.unnest(target_ids[1:max_ids]) AS x;
  IF ids IS NULL THEN
    RETURN; -- empty / NULL input
  END IF;
  RETURN QUERY
  SELECT p.id, public._presence_label(mp.last_active_at)
  FROM pg_catalog.unnest(ids) AS t(id)
  JOIN public.profiles p ON p.id = t.id
  LEFT JOIN public.member_presence mp ON mp.user_id = p.id
  WHERE
    p.id = viewer -- self always allowed
    OR (
      p.show_activity_status IS DISTINCT FROM false
      AND public.can_discover_profile(p.id)
    );
END;
$$;

-- Lock the surface down: no public/anon execution; only authenticated members may call it.
REVOKE ALL ON FUNCTION public.member_presence_labels(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.member_presence_labels(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.member_presence_labels(uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public._presence_label(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._presence_label(timestamptz) FROM anon;

COMMENT ON TABLE public.member_presence IS
  'Private presence store. Self-only RLS: a member reads/writes only their own row. Other members'' presence is exposed ONLY as a coarse label via member_presence_labels(). The raw timestamp of another member is never client-readable.';

-- ── Backfill (guarded, convergent, re-runnable) — does NOT drop the legacy column ─
-- Copy every existing value into member_presence so no presence is lost at cutover. Guarded
-- on column existence so a re-run (e.g. after cleanup 048 has already dropped the column) is
-- a clean no-op. The legacy profiles.last_active_at column is intentionally LEFT INTACT here
-- for backward compatibility; migration 048 removes it after the new code is verified.
--
-- CONVERGENT conflict update: on conflict, keep the LATER of the existing private value and
-- the legacy value (GREATEST) so activity NEVER moves backward, and bump updated_at only when
-- the value actually advances. This is idempotent and safe to run repeatedly.
--
-- RERUN GUIDANCE: run this migration ONCE at expansion, then RERUN IT ONCE MORE immediately
-- before pushing/deploying the new application. Between expansion and cutover the OLD code
-- still writes profiles.last_active_at; the second run reconciles those newer writes forward
-- into member_presence (GREATEST guarantees no regression) so no recent activity is lost.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'last_active_at'
  ) THEN
    INSERT INTO public.member_presence (user_id, last_active_at, updated_at)
    SELECT id, last_active_at, now() FROM public.profiles WHERE last_active_at IS NOT NULL
    ON CONFLICT (user_id) DO UPDATE
      SET last_active_at = GREATEST(public.member_presence.last_active_at, EXCLUDED.last_active_at),
          updated_at = CASE
            WHEN EXCLUDED.last_active_at > public.member_presence.last_active_at THEN now()
            ELSE public.member_presence.updated_at
          END;
  END IF;
END $$;
