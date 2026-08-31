-- 092 — make referrals.referral_note OPTIONAL
--
-- The nomination form asks for four things: name, title, company, email. The "why" note was a
-- fifth, REQUIRED field, enforced both in the API and by a CHECK on the table. Every extra required
-- field on a form whose whole purpose is volume costs submissions, and the note is the one field a
-- member cannot answer in a few seconds.
--
-- THE CONSTRAINT IS DISCOVERED, NOT NAMED. public.referrals is not defined in this migrations
-- folder — it predates it — so the CHECK's name is not knowable from the repo. Guessing a name and
-- using DROP CONSTRAINT IF EXISTS would silently no-op against the real database and leave the
-- constraint in place, which is the worst outcome: the migration reports success and the API then
-- fails at runtime for every note-less nomination. This finds the constraint by its DEFINITION.
--
-- Idempotent: re-running finds nothing to drop and does nothing.

BEGIN;

DO $precheck$
BEGIN
  IF to_regclass('public.referrals') IS NULL THEN
    RAISE EXCEPTION '092 REFUSED: public.referrals does not exist.';
  END IF;
END
$precheck$;

-- 1. Drop every CHECK on public.referrals whose definition references referral_note.
--    Written as a loop because there may be more than one, and because the name is unknown.
DO $drop_checks$
DECLARE
  v_con record;
  v_dropped int := 0;
BEGIN
  FOR v_con IN
    SELECT c.conname, pg_catalog.pg_get_constraintdef(c.oid) AS def
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.referrals'::regclass
      AND c.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%referral_note%'
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.referrals DROP CONSTRAINT %I', v_con.conname);
    RAISE NOTICE '092: dropped CHECK %  (%)', v_con.conname, v_con.def;
    v_dropped := v_dropped + 1;
  END LOOP;

  IF v_dropped = 0 THEN
    RAISE NOTICE '092: no referral_note CHECK found — already optional, or never constrained.';
  END IF;
END
$drop_checks$;

-- 2. Drop NOT NULL if it is set. Separate from the CHECK: a column can be NOT NULL with no CHECK
--    at all, and dropping only the CHECK would still reject a null note.
DO $drop_notnull$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.referrals'::regclass
      AND a.attname = 'referral_note'
      AND a.attnotnull
  ) THEN
    ALTER TABLE public.referrals ALTER COLUMN referral_note DROP NOT NULL;
    RAISE NOTICE '092: dropped NOT NULL on referrals.referral_note.';
  END IF;
END
$drop_notnull$;

COMMENT ON COLUMN public.referrals.referral_note IS
  'Optional free-text reason the member recommended this person. Was required (CHECK + NOT NULL) '
  'until migration 092; the nomination form now asks only for name, title, company and email. '
  'Existing notes are unchanged — nothing is backfilled, blanked or rewritten.';

-- 3. Verify. A migration that reports success while leaving the constraint in place would surface
--    as a runtime failure on the first note-less nomination, so refuse rather than allow that.
DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.referrals'::regclass
      AND c.contype = 'c'
      AND pg_catalog.pg_get_constraintdef(c.oid) ILIKE '%referral_note%'
  ) THEN
    RAISE EXCEPTION '092 FAILED: a referral_note CHECK still exists after the drop loop.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = 'public.referrals'::regclass
      AND a.attname = 'referral_note' AND a.attnotnull
  ) THEN
    RAISE EXCEPTION '092 FAILED: referrals.referral_note is still NOT NULL.';
  END IF;
END
$verify$;

COMMIT;
