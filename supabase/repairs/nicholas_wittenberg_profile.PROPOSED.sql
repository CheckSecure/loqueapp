-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- NICHOLAS WITTENBERG — profile repair. GATE IS FALSE. As checked in, this changes nothing.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Running it as-is performs the whole repair, verifies it, prints before/after, and then RAISES —
-- which rolls every write back. Applying means changing ONE literal, v_apply, and nothing else.
--
-- BEFORE RUNNING: execute supabase/audits/nicholas_wittenberg_profile_audit.sql and paste its
-- pins_to_paste block into the five c_expect_* constants below. This file refuses to run while any
-- of them is left unset. It will not search for its own target and it will not guess.
--
-- ─── WHAT IT CHANGES, EXHAUSTIVELY ────────────────────────────────────────────────────────────
--   company           -> 'Armedia'
--   exact_job_title   -> 'Corporate Counsel'      (the display authority)
--   role_type         -> 'In-House Counsel'       ALWAYS — this is the operator-authorized
--                                                 correction, not a conditional cleanup. Whatever
--                                                 the audit found (Advisor, Other, anything else,
--                                                 including a value that is perfectly compatible
--                                                 with employed status) is replaced.
--   current_status    -> 'employed'
--   updated_at        -> now()
--
-- ─── WHAT IT DELIBERATELY DOES NOT CHANGE ─────────────────────────────────────────────────────
--   title is PRESERVED. exact_job_title is the display authority — lib/professionalIdentity.ts
--   resolves the shown title as (exact_job_title || title || role_type), so setting
--   exact_job_title = 'Corporate Counsel' is sufficient and title never enters the display. The
--   allowed-column diff below aborts the repair if title moves.
--
--   Nothing else moves either: not account_status, profile_complete, seniority, expertise, bio,
--   avatar, location, previous_roles, credits, matches, introductions, intro_requests,
--   notifications, auth, or any other column or table. The postcondition proves it by comparing a
--   snapshot of the WHOLE row before and after and refusing if anything outside the allowed set
--   changed.
--
-- IDEMPOTENT: running it twice leaves the same values and reports 0 rows changed the second time.
-- The pre-repair pins accept EITHER the audited value OR the already-repaired target value, so a
-- second run verifies and reports rather than refusing.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

BEGIN;

DO $repair$
DECLARE
  -- ─────────────────────────────────────────────────────────────────────────────────────────────
  -- THE OPERATOR GATE. false = dry run: everything runs, is verified, then rolled back.
  v_apply constant boolean := false;

  -- THE REVIEWED PROFILE. Paste the id the audit reported. NULL means "not reviewed yet" and the
  -- block refuses — a repair that searched for its own target could pick the wrong person.
  c_expect_id constant uuid := NULL;

  -- EXPECTED PRE-REPAIR VALUES, exactly as the audit's pins_to_paste reported them. All four are
  -- REQUIRED: the sentinel below means "not pasted yet" and the block refuses. '(null)' is a real
  -- pin meaning the column is NULL or blank. These prove the row is still the reviewed row; they
  -- do NOT decide what gets written.
  c_unset            constant text := '<PASTE FROM AUDIT>';
  c_expect_role_type constant text := '<PASTE FROM AUDIT>';
  c_expect_company   constant text := '<PASTE FROM AUDIT>';
  c_expect_job_title constant text := '<PASTE FROM AUDIT>';
  c_expect_status    constant text := '<PASTE FROM AUDIT>';

  -- Identity pins. Leave NULL to skip; any non-NULL value that does not match aborts before a write.
  c_expect_full_name    constant text := 'Nicholas Wittenberg';
  c_expect_email_domain constant text := NULL;   -- e.g. 'armedia.com'; NULL = do not pin
  -- ─────────────────────────────────────────────────────────────────────────────────────────────

  -- THE OPERATOR-AUTHORIZED TARGET.
  c_company constant text := 'Armedia';
  c_title   constant text := 'Corporate Counsel';
  c_role    constant text := 'In-House Counsel';
  c_status  constant text := 'employed';

  v_n         integer;
  v_before    jsonb;
  v_after     jsonb;
  v_row       public.profiles%ROWTYPE;
  v_changed   integer := 0;
  v_display   text;
  v_diff_keys text[];
  v_seen      text;
  c_allowed   constant text[] := ARRAY['company','exact_job_title','role_type','current_status','updated_at'];
BEGIN
  -- ── EVERY PIN MUST BE PASTED ────────────────────────────────────────────────────────────────
  IF c_expect_id IS NULL THEN
    RAISE EXCEPTION
      'REPAIR REFUSED: c_expect_id is not set. Run supabase/audits/nicholas_wittenberg_profile_audit.sql '
      'first and paste its pins_to_paste block in. This file will not search for its own target.';
  END IF;
  IF c_expect_role_type = c_unset OR c_expect_company = c_unset
     OR c_expect_job_title = c_unset OR c_expect_status = c_unset THEN
    RAISE EXCEPTION
      'REPAIR REFUSED: the expected PRE-REPAIR values are not pasted. Copy pins_to_paste from the '
      'audit into c_expect_role_type, c_expect_company, c_expect_job_title and c_expect_status. '
      'They prove the row is still the one that was reviewed.';
  END IF;

  -- ── EXACTLY ONE reviewed profile, and it must be the one that was reviewed ──────────────────
  SELECT count(*) INTO v_n FROM public.profiles WHERE id = c_expect_id;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'REPAIR REFUSED: % profiles match the pinned id.', v_n;
  END IF;

  SELECT count(*) INTO v_n
    FROM public.profiles
   WHERE full_name ILIKE '%wittenberg%' OR email ILIKE '%wittenberg%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION
      'REPAIR REFUSED: the audit search matches % profiles, not 1. A duplicate identity must be '
      'resolved by a person before anything is rewritten.', v_n;
  END IF;

  SELECT * INTO v_row FROM public.profiles WHERE id = c_expect_id FOR UPDATE;

  IF c_expect_full_name IS NOT NULL AND btrim(COALESCE(v_row.full_name,'')) <> c_expect_full_name THEN
    RAISE EXCEPTION
      'REPAIR REFUSED: full_name does not match the reviewed value. The row changed since the audit.';
  END IF;
  IF c_expect_email_domain IS NOT NULL
     AND lower(split_part(COALESCE(v_row.email,''), '@', 2)) <> lower(c_expect_email_domain) THEN
    RAISE EXCEPTION 'REPAIR REFUSED: email domain does not match the reviewed value.';
  END IF;

  -- ── THE ROW STILL HOLDS THE AUDITED PRE-REPAIR VALUES ───────────────────────────────────────
  -- Each field must be either what the audit saw, or already the target (a re-run). Anything else
  -- means somebody or something changed the row since the review, and this stops.
  v_seen := COALESCE(NULLIF(btrim(COALESCE(v_row.role_type,'')),''),'(null)');
  IF v_seen <> c_expect_role_type AND v_seen <> c_role THEN
    RAISE EXCEPTION
      'REPAIR REFUSED: role_type is "%" but the audit reported "%". The row changed since the '
      'audit — re-run the audit and re-review before repairing.', v_seen, c_expect_role_type;
  END IF;

  v_seen := COALESCE(NULLIF(btrim(COALESCE(v_row.company,'')),''),'(null)');
  IF v_seen <> c_expect_company AND v_seen <> c_company THEN
    RAISE EXCEPTION
      'REPAIR REFUSED: company is "%" but the audit reported "%".', v_seen, c_expect_company;
  END IF;

  v_seen := COALESCE(NULLIF(btrim(COALESCE(v_row.exact_job_title,'')),''),'(null)');
  IF v_seen <> c_expect_job_title AND v_seen <> c_title THEN
    RAISE EXCEPTION
      'REPAIR REFUSED: exact_job_title is "%" but the audit reported "%".', v_seen, c_expect_job_title;
  END IF;

  v_seen := COALESCE(NULLIF(btrim(COALESCE(v_row.current_status,'')),''),'(null)');
  IF v_seen <> c_expect_status AND v_seen <> c_status THEN
    RAISE EXCEPTION
      'REPAIR REFUSED: current_status is "%" but the audit reported "%".', v_seen, c_expect_status;
  END IF;

  v_before := pg_catalog.to_jsonb(v_row);

  RAISE NOTICE 'BEFORE — role_type=% exact_job_title=% title=% company=% current_status=%',
    COALESCE(v_row.role_type,'(null)'), COALESCE(v_row.exact_job_title,'(null)'),
    COALESCE(v_row.title,'(null)'), COALESCE(v_row.company,'(null)'),
    COALESCE(v_row.current_status,'(null)');

  -- ── THE WRITE. Four fields, set UNCONDITIONALLY to the authorized values. ───────────────────
  -- role_type is assigned c_role outright. It is NOT conditioned on whether the stored value is
  -- compatible with employed status: an Advisor row is compatible with 'employed' and is still
  -- wrong, and correcting it is the point of this repair. The WHERE clause only avoids a
  -- no-op write (and a pointless updated_at bump) when every field is already correct.
  UPDATE public.profiles
     SET company         = c_company,
         exact_job_title = c_title,
         role_type       = c_role,
         current_status  = c_status,
         updated_at      = pg_catalog.now()
   WHERE id = c_expect_id
     AND (COALESCE(company,'')         IS DISTINCT FROM c_company
       OR COALESCE(exact_job_title,'') IS DISTINCT FROM c_title
       OR COALESCE(role_type,'')       IS DISTINCT FROM c_role
       OR COALESCE(current_status,'')  IS DISTINCT FROM c_status);
  GET DIAGNOSTICS v_changed = ROW_COUNT;

  SELECT * INTO v_row FROM public.profiles WHERE id = c_expect_id;
  v_after := pg_catalog.to_jsonb(v_row);

  RAISE NOTICE 'AFTER  — role_type=% exact_job_title=% title=% company=% current_status=%  (rows changed: %)',
    COALESCE(v_row.role_type,'(null)'), COALESCE(v_row.exact_job_title,'(null)'),
    COALESCE(v_row.title,'(null)'), COALESCE(v_row.company,'(null)'),
    COALESCE(v_row.current_status,'(null)'), v_changed;

  -- ── NOTHING OUTSIDE THE ALLOWED SET MOVED ──────────────────────────────────────────────────
  SELECT pg_catalog.array_agg(k ORDER BY k) INTO v_diff_keys
    FROM (SELECT pg_catalog.jsonb_object_keys(v_before) AS k) ks
   WHERE (v_before -> k) IS DISTINCT FROM (v_after -> k)
     AND k <> ALL (c_allowed);
  IF v_diff_keys IS NOT NULL AND pg_catalog.array_length(v_diff_keys, 1) > 0 THEN
    RAISE EXCEPTION
      'REPAIR ABORTED: fields outside the allowed set changed: %. Allowed: %.',
      pg_catalog.array_to_string(v_diff_keys, ', '), pg_catalog.array_to_string(c_allowed, ', ');
  END IF;

  -- title is not in c_allowed, so the diff above already catches it. Asserted separately because
  -- preserving it is a stated requirement, not an incidental consequence.
  IF (v_before -> 'title') IS DISTINCT FROM (v_after -> 'title') THEN
    RAISE EXCEPTION 'REPAIR ABORTED: title was modified. exact_job_title is the display authority.';
  END IF;

  -- ── THE CANONICAL CLASSIFICATION IS EXACTLY RIGHT ──────────────────────────────────────────
  IF btrim(COALESCE(v_row.role_type,''))       <> c_role
     OR btrim(COALESCE(v_row.exact_job_title,'')) <> c_title
     OR btrim(COALESCE(v_row.company,''))         <> c_company
     OR btrim(COALESCE(v_row.current_status,'')) <> c_status THEN
    RAISE EXCEPTION
      'REPAIR ABORTED: the row is not exactly the authorized target. role_type=% exact_job_title=% '
      'company=% current_status=%.',
      COALESCE(v_row.role_type,'(null)'), COALESCE(v_row.exact_job_title,'(null)'),
      COALESCE(v_row.company,'(null)'), COALESCE(v_row.current_status,'(null)');
  END IF;

  -- ── THE DISPLAYED IDENTITY IS EXACTLY RIGHT ────────────────────────────────────────────────
  v_display := btrim(COALESCE(v_row.exact_job_title, v_row.title, v_row.role_type, ''))
               || ' at ' || btrim(COALESCE(v_row.company,''));
  IF v_display <> 'Corporate Counsel at Armedia' THEN
    RAISE EXCEPTION 'REPAIR ABORTED: display resolves to "%", expected "Corporate Counsel at Armedia".', v_display;
  END IF;
  RAISE NOTICE 'CLASSIFICATION — role_type=% (canonical in-house)', v_row.role_type;
  RAISE NOTICE 'DISPLAY — %', v_display;

  IF NOT v_apply THEN
    RAISE EXCEPTION
      'DRY RUN COMPLETE — NOTHING WAS KEPT. % row(s) would change; role_type would be "%" and the '
      'display would resolve to "%". Every guard passed and this exception rolls it all back. '
      'Set v_apply := true to apply.',
      v_changed, v_row.role_type, v_display;
  END IF;

  RAISE NOTICE 'REPAIR APPLIED — % row(s) changed.', v_changed;
END
$repair$;

-- Reachable ONLY when v_apply was true. With the gate false the block above raises, the transaction
-- aborts, and PostgreSQL treats this as a ROLLBACK.
COMMIT;
