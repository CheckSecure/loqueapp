-- ==============================================================================================
-- 069 - THREE DELIVERY PURPOSES, AND AN EVENT-KEYED CLAIM FOR NEW-INTRODUCTION EMAILS
--
-- Narrowly additive. Adds nothing that grants privilege, creates no function, and touches no
-- matching, capacity, scoring, credit, match, conversation or finalization object. Migrations
-- 063-068 are untouched, and no browser role gains anything.
--
-- --- WHY A MIGRATION IS REQUIRED AT ALL --------------------------------------------------------
-- public.reminder_deliveries (065) pins purpose with
--     CHECK (purpose IN ('wednesday_intro_reminder'))
-- so the catch-up campaign and the new-introduction outbox literally cannot insert a row today.
-- This is not a preference; it is a hard constraint failure.
--
-- --- WHY cycle_key IS NOT ENOUGH FOR NEW INTRODUCTIONS -----------------------------------------
-- cycle_key means "which ISO week", and the 065 claim index is (member_id, purpose, cycle_key).
-- That is the correct authority for a WEEKLY reminder: one per member per week, by definition.
-- It is the WRONG authority for new introductions. A member can legitimately receive introductions
-- twice in one week - an admin-approved batch on Monday and a weekly reciprocal on Thursday - and a
-- week-keyed claim would silently collapse the second delivery and never send it.
--
-- Rather than overloading cycle_key with something that is not a cycle, this adds an explicit
-- event_key: a stable fingerprint of the COMMITTED artifact (the set of intro_requests rows that
-- actually became visible for that member in that operation). Consequences that fall out of that
-- choice, rather than being bolted on:
--   * an idempotent re-run that creates NO new rows produces NO key, so nothing is enqueued;
--   * a retry that commits the SAME rows produces the SAME key, so it dedupes;
--   * two genuinely different deliveries produce different keys, so both are sent.
--
-- cycle_key keeps its honest meaning throughout: the calendar week the delivery belongs to.
--
-- --- A NOTE ON THE WEDNESDAY PURPOSE NAME ------------------------------------------------------
-- The review named the weekly purpose 'wednesday_unanswered'. The value already deployed in code
-- and pinned by the 065 CHECK is 'wednesday_intro_reminder' (lib/reminders/wednesdayIntroReminder.ts
-- REMINDER_PURPOSE, live at commit 952e06b). Renaming it here would create a window in which the
-- deployed cron cannot insert its claim at all - the constraint would reject the value the running
-- code sends. The live name is therefore KEPT and the two new purposes are added alongside it.
-- Renaming is a separate, coordinated change and is deliberately not attempted inside this one.
-- ==============================================================================================

BEGIN;

-- 1. Widen the purpose vocabulary. The live value is preserved exactly.
ALTER TABLE public.reminder_deliveries
  DROP CONSTRAINT IF EXISTS reminder_deliveries_purpose_check;

ALTER TABLE public.reminder_deliveries
  ADD CONSTRAINT reminder_deliveries_purpose_check
  CHECK (purpose IN (
    'wednesday_intro_reminder',          -- weekly unanswered-introduction reminder (065, live)
    'catchup_unanswered_2026_08_20',     -- one-time catch-up campaign, fixed in server code
    'new_introductions'                  -- ongoing "new introductions are available"
  ));

-- 2. The committed-artifact fingerprint. NULL for week-keyed purposes, whose authority IS the week.
ALTER TABLE public.reminder_deliveries
  ADD COLUMN IF NOT EXISTS event_key text NULL;

COMMENT ON COLUMN public.reminder_deliveries.event_key IS
  'Stable fingerprint of the COMMITTED artifact a delivery announces - for new_introductions, a hash over the sorted ids of the intro_requests rows that actually became visible for this member in one logical operation. NULL for purposes whose dedupe authority is the calendar week. Never a batch id: reciprocal cards have no batch envelope.';

-- 3. Exactly the purposes that are event-keyed are the ones carrying a key. This is what stops a
--    future caller from quietly reintroducing week-collapsing behaviour for new introductions.
ALTER TABLE public.reminder_deliveries
  DROP CONSTRAINT IF EXISTS reminder_deliveries_event_key_shape_chk;

ALTER TABLE public.reminder_deliveries
  ADD CONSTRAINT reminder_deliveries_event_key_shape_chk
  CHECK ((purpose = 'new_introductions') = (event_key IS NOT NULL));

-- 4. The 065 claim index must stop governing event-keyed rows, or it would collapse two legitimate
--    deliveries in one week back into one. Recreated with the exclusion. The table is empty in
--    production, so this drop/recreate cannot lose or reject any row.
DROP INDEX IF EXISTS public.reminder_deliveries_active_claim_uniq;

CREATE UNIQUE INDEX reminder_deliveries_active_claim_uniq
  ON public.reminder_deliveries (member_id, purpose, cycle_key)
  WHERE event_key IS NULL
    AND status IN ('claimed', 'accepted', 'delivered', 'deferred');

-- 5. The event-keyed claim. Same active-state set, so 'failed' stays outside it and a genuine
--    provider failure remains retryable under the existing lease model.
CREATE UNIQUE INDEX IF NOT EXISTS reminder_deliveries_event_claim_uniq
  ON public.reminder_deliveries (member_id, purpose, event_key)
  WHERE event_key IS NOT NULL
    AND status IN ('claimed', 'accepted', 'delivered', 'deferred');

-- 6. Lookup for the catch-up campaign's aggregate progress reads. Not a claim.
CREATE INDEX IF NOT EXISTS reminder_deliveries_purpose_status_idx
  ON public.reminder_deliveries (purpose, status);

COMMIT;
