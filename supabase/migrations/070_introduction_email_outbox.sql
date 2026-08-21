-- ==============================================================================================
-- 070 - TRANSACTIONAL OUTBOX FOR NEWLY VISIBLE INTRODUCTION CARDS
--
-- THE GAP THIS CLOSES. Announcing a new introduction from application code AFTER the writing
-- transaction commits is not durable, however carefully it is written:
--
--     1. the visible 'suggested' card COMMITS
--     2. the process crashes / times out / is terminated
--     3. no durable record of "this member must be emailed" exists anywhere
--     4. unless some later caller happens to revisit that member, the email is lost forever
--
-- No amount of try/catch in step 2's process fixes step 3. The record has to be created by the
-- SAME transaction that commits the card, which means it has to be created in the database.
--
-- So a row trigger writes the outbox event inside the writer's transaction. Card and event commit
-- together or not at all. A worker drains the outbox later, and a crash merely delays the email.
--
-- WHY A TRIGGER RATHER THAN FOUR CALL SITES. The writers are public.materialize_admin_pair (064),
-- public.create_reciprocal_suggestion (063), public.promote_queued_rows (063) and
-- public.place_batch_rows (063), reached from a dozen application entry points. Enumerating them
-- means correctness depends on remembering to add the next one. The trigger keys on the fact that
-- actually matters - a row becoming visible - so a future writer is covered whether or not anyone
-- remembers this file exists.
--
-- --- NO HISTORICAL BLAST -----------------------------------------------------------------------
-- The trigger fires only on writes that happen AFTER it exists. It performs no backfill and this
-- migration inserts no rows, so the ~188 'suggested' cards already in production generate exactly
-- zero outbox events and exactly zero automatic emails. Reaching those members is the one-time
-- catch-up campaign's job, under explicit admin action, and nothing here changes that.
--
-- --- WHAT DOES NOT ENQUEUE ---------------------------------------------------------------------
-- An UPDATE that leaves a row 'suggested' without it NEWLY becoming visible (suggested -> suggested)
-- is excluded by the OLD.status IS DISTINCT FROM check. Every other status - queued, pending,
-- approved, accepted, admin_pending, passed, declined, rejected, expired, archived, hidden,
-- hidden_permanent, accepted_pending_payment - is excluded because the guard tests for exactly
-- 'suggested'. A card that expires therefore produces no event, and no email.
--
-- --- PRIVILEGE POSTURE -------------------------------------------------------------------------
-- Migrations 063-068 are untouched. This grants nothing to PUBLIC, anon or authenticated; it
-- creates no browser-reachable RPC; and it does NOT restore service_role EXECUTE on
-- public.consume_credits_and_create_match, which migration 068 removed and which must stay removed.
-- ==============================================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.introduction_email_outbox (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The committed artifact this event announces. CASCADE so a deleted card cannot strand an event.
  intro_request_id   uuid NOT NULL REFERENCES public.intro_requests(id) ON DELETE CASCADE,
  -- Who to email: the card's OWNER (requester_id). A reciprocal creation writes two directional
  -- rows, so it produces one event per member - which is what makes both sides get announced.
  member_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'claimed', 'sent', 'failed', 'skipped')),

  -- ── LEASED OWNERSHIP ──────────────────────────────────────────────────────────────────────────
  -- A claim is not just a status. Without a token, a worker that stalled past its lease could still
  -- come back and mark an event 'sent' that a DIFFERENT worker has since legitimately reclaimed and
  -- is actively delivering - settling someone else's in-flight work and hiding a real send. Every
  -- completion, release and failure is therefore conditioned on BOTH the status and the exact token
  -- the worker was issued, so a stale worker's update matches zero rows and it learns it lost.
  claim_token        uuid NULL,
  claimed_at         timestamptz NULL,
  claim_expires_at   timestamptz NULL,

  attempt_count      integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  -- Coarse class only, e.g. 'provider_error'. NEVER a raw provider message, and never a token.
  last_error_class   text NULL,
  processed_at       timestamptz NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  -- A claim is all-or-nothing: exactly the claimed rows carry a token, a start and an expiry. This
  -- makes "claimed but unleased" - the state that would let the racy predicate below sneak back in -
  -- unrepresentable rather than merely avoided by convention.
  CONSTRAINT introduction_email_outbox_claim_shape_chk CHECK (
    (status = 'claimed')
      = (claim_token IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL)
  ),
  -- A lease that ends before it starts is not a lease.
  CONSTRAINT introduction_email_outbox_lease_order_chk CHECK (
    claim_expires_at IS NULL OR claimed_at IS NULL OR claim_expires_at > claimed_at
  ),
  -- Exactly the terminal outcomes carry a processing timestamp. 'failed' is NOT terminal: it is
  -- retryable, so it deliberately does not qualify.
  CONSTRAINT introduction_email_outbox_processed_shape_chk CHECK (
    (status IN ('sent', 'skipped')) = (processed_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.introduction_email_outbox IS
  'Transactional outbox: one event per intro_requests row that BECAME VISIBLE, written by a trigger inside the writer''s own transaction so a card can never commit without its announcement. Holds internal references and processing state only - no email body, no name, no address, no provider payload, no secret.';

-- ONE event per directional card, for all time. A retried writer, a re-run generator, or a card that
-- cycles back into visibility cannot produce a second announcement for the same artifact.
CREATE UNIQUE INDEX IF NOT EXISTS introduction_email_outbox_card_uniq
  ON public.introduction_email_outbox (intro_request_id);

-- Deterministic selection, one index per thing the worker actually asks for: the oldest PENDING
-- events, and CLAIMED events whose lease has run out. Partial, so neither scans settled rows.
CREATE INDEX IF NOT EXISTS introduction_email_outbox_pending_idx
  ON public.introduction_email_outbox (created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS introduction_email_outbox_stale_claim_idx
  ON public.introduction_email_outbox (claim_expires_at)
  WHERE status = 'claimed';
CREATE INDEX IF NOT EXISTS introduction_email_outbox_member_idx
  ON public.introduction_email_outbox (member_id, status);

ALTER TABLE public.introduction_email_outbox ENABLE ROW LEVEL SECURITY;
-- RLS on with ZERO policies: no row is reachable by any non-superuser role through PostgREST, even
-- if a grant were added by accident later.
REVOKE ALL ON TABLE public.introduction_email_outbox FROM PUBLIC;
REVOKE ALL ON TABLE public.introduction_email_outbox FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.introduction_email_outbox TO service_role;

-- ── The trigger ────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_intro_request_visible_outbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $tg$
BEGIN
  -- INSERT: the card is born visible.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'suggested' THEN
      INSERT INTO public.introduction_email_outbox (intro_request_id, member_id)
      VALUES (NEW.id, NEW.requester_id)
      ON CONFLICT (intro_request_id) DO NOTHING;
    END IF;
    RETURN NULL;
  END IF;

  -- UPDATE: only a transition INTO visibility counts. suggested -> suggested is not a new card,
  -- and every non-visible target status fails the equality test.
  IF NEW.status = 'suggested' AND OLD.status IS DISTINCT FROM 'suggested' THEN
    INSERT INTO public.introduction_email_outbox (intro_request_id, member_id)
    VALUES (NEW.id, NEW.requester_id)
    ON CONFLICT (intro_request_id) DO NOTHING;
  END IF;

  RETURN NULL;
END;
$tg$;

REVOKE ALL ON FUNCTION public.tg_intro_request_visible_outbox() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tg_intro_request_visible_outbox() FROM anon, authenticated;

COMMENT ON FUNCTION public.tg_intro_request_visible_outbox() IS
  'AFTER INSERT OR UPDATE OF status on public.intro_requests. Writes one introduction_email_outbox event when a row becomes VISIBLE, inside the writer''s transaction, so the card and its announcement commit together. Fires for every writer - materialize_admin_pair, create_reciprocal_suggestion, promote_queued_rows, place_batch_rows, and any future one - because it keys on the row state rather than on the caller.';

DROP TRIGGER IF EXISTS intro_requests_visible_outbox_aiu ON public.intro_requests;

-- AFTER, so it never sees a row the transaction later rolls back as committed. UPDATE OF status
-- narrows it further: an update that does not touch status cannot fire it at all.
CREATE TRIGGER intro_requests_visible_outbox_aiu
  AFTER INSERT OR UPDATE OF status ON public.intro_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_intro_request_visible_outbox();

COMMIT;
