-- 061_profiles_complete_requires_location.sql
--
-- Defense in depth for the required-physical-location rule. The application is the
-- primary authority (lib/validation/location.ts, applied at completeOnboarding,
-- /api/profile/complete, /api/profile/update and updateProfile); this constraint
-- exists so no future writer — a script, a backfill, a psql session, a new route —
-- can mark a profile complete with a missing or placeholder location.
--
-- WHY: three completed profiles reached profile_complete=true with no usable
-- location (two NULL, one "Remote"). "Remote" is a work arrangement, not a place.
-- Those rows are corrected separately, by immutable profile ID. This migration
-- contains NO member IDs and changes NO data.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- UNICODE PARITY — WHY THIS CONSTRAINT IS DELIBERATELY COARSER THAN THE APP
--
-- The application accepts every script: "New York, NY", "Boston", "Asheville, NC",
-- "London, UK", "Singapore", "São Paulo, Brazil", "Kraków", "München", "東京",
-- "北京", "دبي", "ירושלים". A constraint that rejected any value the validator
-- accepted would break a legitimate member's save, so this constraint enforces
-- ONLY rules that are byte-for-byte deterministic in both engines:
--
--              | non-blank | <= 120 chars | placeholder list | >= 2 letters
--   TypeScript |     x     |      x       |        x         |      x
--   CHECK here |     x     |      x       |        x         |      -
--
-- The letter-count rule is intentionally NOT expressed here. Writing "is a letter"
-- in SQL requires [[:alpha:]] / [[:punct:]], whose behaviour depends on the
-- database's lc_ctype — the same "東京" could pass under one locale and fail under
-- another. Reliable parity beats an overcomplicated constraint, so that rule stays
-- server-side where it is Unicode-safe. The floor below is never STRICTER than the
-- TypeScript validator; lib/__tests__/required-location.test.ts pins that invariant
-- by modelling this exact SQL and asserting TS-accepted ⇒ SQL-accepted.
--
-- Every construct below is locale-independent by construction:
--   * trim uses an explicit ASCII whitespace set, not the default (space-only)
--     btrim and not \s (which is [[:space:]] and therefore locale-dependent);
--   * the placeholder strip enumerates A-Za-z0-9 literally rather than using the
--     ranges a-z / A-Z, whose membership is collation-dependent in a non-C locale;
--   * lowercasing uses translate() over the 26 ASCII letters instead of lower(),
--     which is locale-sensitive (Turkish I/İ);
--   * length() counts characters, and JS .length counts UTF-16 code units, so the
--     app can only ever count the same or MORE — never fewer.
--
-- The key derivation is exactly the two steps lib/validation/location.ts performs,
-- in the same order: strip to ASCII alphanumerics FIRST, then lowercase. Non-Latin
-- values key to the empty string ("東京" → '', "دبي" → '') in both engines, and the
-- empty string is never in the placeholder list, so they are always kept.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IT ENFORCES
--   profile_complete IS NOT TRUE → location may be anything, including NULL.
--                                  A member mid-draft is never blocked.
--   profile_complete IS TRUE     → location must be present, non-blank after
--                                  trimming, at most 120 characters, and not a
--                                  placeholder-only answer.
--
-- DELIBERATELY NOT ENFORCED: no comma, no US state, no country, no ASCII
-- requirement, no character-set restriction, and no existence/geocoding check.
-- This is a FORMAT rule only — nothing here verifies the place is real or that the
-- member is there.
--
-- ADDITIVE + IDEMPOTENT: creates one constraint, guarded by a pg_constraint lookup.
-- No column is added, altered or dropped. No data is read, written or migrated.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLOUT ORDER — the preflight is NOT optional
--
--   1. Run PREFLIGHT A below and fix EVERY row it returns. Do not assume the three
--      known rows are the only ones.
--   2. Apply this migration (adds the constraint as NOT VALID).
--   3. Re-run PREFLIGHT A; when it returns zero rows, run the VALIDATE statement
--      at the bottom of this file.
--
-- WHY NOT VALID FIRST: a plain CHECK is verified against the whole table at
-- creation time, so a single legacy violating row aborts the migration. NOT VALID
-- adds the constraint without that scan while STILL enforcing it on every INSERT
-- and UPDATE from that moment on — which is the protection we actually want.
--
-- OPERATIONAL CAVEAT: because NOT VALID still enforces on UPDATE, any row that is
-- still violating after step 2 will reject ALL updates to it (trust score,
-- heartbeat, preferences, everything) until its location is corrected. That is
-- exactly why step 1 comes first.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PREFLIGHT A — REQUIRED, READ-ONLY. Exactly mirrors the CHECK below, so its
-- result set is precisely the rows that would violate the constraint. Must return
-- zero rows before VALIDATE. Selects only; mutates nothing.
--
--   SELECT
--     id,
--     email,
--     location,
--     CASE
--       WHEN location IS NULL THEN 'null'
--       WHEN btrim(location, E' \t\n\r\f\v') = '' THEN 'blank'
--       WHEN length(btrim(location, E' \t\n\r\f\v')) > 120 THEN 'too_long'
--       ELSE 'placeholder'
--     END AS reason,
--     updated_at
--   FROM profiles
--   WHERE profile_complete IS TRUE
--     AND NOT (
--       location IS NOT NULL
--       AND btrim(location, E' \t\n\r\f\v') <> ''
--       AND length(btrim(location, E' \t\n\r\f\v')) <= 120
--       AND translate(
--             regexp_replace(
--               location,
--               '[^abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789]',
--               '', 'g'),
--             'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'
--           ) <> ALL (ARRAY[
--             'remote','remoteonly','anywhere','virtual','na','none','notapplicable',
--             'prefernottosay','tbd','remotefirst','fullyremote','workfromhome','wfh',
--             'hybrid','distributed','digitalnomad','nomad','online','internet','global',
--             'worldwide','everywhere','nowhere','earth','unknown','undisclosed','tba',
--             'prefernottoanswer','declinetostate'
--           ])
--     )
--   ORDER BY reason, updated_at;
--
-- Companion count, for a quick "is it done yet" check:
--
--   SELECT count(*) AS violating_completed_profiles
--   FROM profiles
--   WHERE profile_complete IS TRUE
--     AND NOT ( /* same four-part predicate as above */ );
--
-- ─────────────────────────────────────────────────────────────────────────────
-- PREFLIGHT B — ADVISORY, READ-ONLY, OPTIONAL. Rows that satisfy the database
-- floor but would FAIL the richer server-side validator: a completed profile whose
-- location carries fewer than two letters ("-", "...", "123"). These do NOT block
-- VALIDATE and are not a constraint violation; they are a short human-review list
-- of values the app would no longer accept on save.
--
-- BEST EFFORT ONLY: [[:punct:]] and [[:digit:]] are locale-dependent, which is the
-- very reason this rule is not in the constraint. Treat the output as a prompt to
-- look, never as an authoritative verdict.
--
--   SELECT id, email, location, updated_at
--   FROM profiles
--   WHERE profile_complete IS TRUE
--     AND location IS NOT NULL
--     AND btrim(location, E' \t\n\r\f\v') <> ''
--     AND length(
--           regexp_replace(btrim(location, E' \t\n\r\f\v'),
--                          '[[:space:][:digit:][:punct:]]', '', 'g')
--         ) < 2
--   ORDER BY updated_at;
--
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  -- Scoped to public.profiles on purpose. Constraint names are unique only per
  -- relation (pg_constraint is keyed on conrelid + contypid + conname), so a
  -- name-only lookup would match an identically-named constraint on ANY other
  -- table and silently skip protecting profiles.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'profiles_complete_requires_location_chk'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_complete_requires_location_chk
      CHECK (
        profile_complete IS NOT TRUE
        OR (
          location IS NOT NULL
          -- non-blank after trimming. Explicit ASCII whitespace set: bare btrim()
          -- strips only spaces, and \s is locale-dependent.
          AND btrim(location, E' \t\n\r\f\v') <> ''
          -- reasonable maximum, matching LOCATION_MAX_LENGTH in
          -- lib/validation/location.ts. length() counts characters, not bytes, so
          -- "東京" counts 2 — the same budget every script gets.
          AND length(btrim(location, E' \t\n\r\f\v')) <= 120
          -- placeholder-ONLY answers. Key derivation matches the TypeScript
          -- validator exactly: (1) strip to ASCII alphanumerics, (2) lowercase.
          -- Characters are enumerated rather than ranged, and translate() replaces
          -- lower(), so neither step depends on collation or lc_ctype. Matched
          -- against the WHOLE value, never as a substring, so "Virginia Beach, VA",
          -- "Nashville, TN" and "Naples, Italy" all pass. Non-Latin values key to
          -- '' and are therefore always kept.
          AND translate(
                regexp_replace(
                  location,
                  '[^abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789]',
                  '', 'g'),
                'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'
              ) <> ALL (ARRAY[
                'remote','remoteonly','anywhere','virtual','na','none','notapplicable',
                'prefernottosay','tbd','remotefirst','fullyremote','workfromhome','wfh',
                'hybrid','distributed','digitalnomad','nomad','online','internet','global',
                'worldwide','everywhere','nowhere','earth','unknown','undisclosed','tba',
                'prefernottoanswer','declinetostate'
              ])
        )
      )
      NOT VALID;
  END IF;
END $$;

COMMENT ON CONSTRAINT profiles_complete_requires_location_chk ON public.profiles IS
  'A profile marked complete must carry a non-blank, non-placeholder physical location of at most 120 characters. Locale-independent by construction; accepts every script. Coarser than lib/validation/location.ts on purpose (no letter-count rule) so the constraint can never reject a value the application accepted. Format check only — no verification that the place exists or that the member is there.';

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3 — run ONLY after PREFLIGHT A returns zero rows. Takes a SHARE UPDATE
-- EXCLUSIVE lock (concurrent reads and writes continue) and promotes the
-- constraint to fully validated.
--
--   ALTER TABLE public.profiles
--     VALIDATE CONSTRAINT profiles_complete_requires_location_chk;
--
-- Rollback, if ever needed:
--
--   ALTER TABLE public.profiles
--     DROP CONSTRAINT IF EXISTS profiles_complete_requires_location_chk;
