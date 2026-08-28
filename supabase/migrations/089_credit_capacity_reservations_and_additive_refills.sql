-- 089 — additive monthly credits + hard, reservation-aware capacity authority
-- No historical row is changed. Existing included balances above 20 are preserved and may only fall.

BEGIN;

DO $precheck$
BEGIN
  IF to_regclass('public.meeting_credits') IS NULL
     OR to_regclass('public.credit_refills') IS NULL
     OR to_regclass('public.credit_grants') IS NULL
     OR to_regclass('public.membership_credit_cycles') IS NULL THEN
    RAISE EXCEPTION '089 REFUSED: migrations 052, 053, 087 and 088 must already be applied.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.meeting_credits WHERE COALESCE(balance,0) > 50) THEN
    RAISE EXCEPTION '089 REFUSED: a balance above the combined 50-credit cap exists.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.meeting_credits
             WHERE COALESCE(balance,0) <> COALESCE(free_credits,0) + COALESCE(premium_credits,0)) THEN
    RAISE EXCEPTION '089 REFUSED: meeting_credits balance drift exists.';
  END IF;
END
$precheck$;

CREATE TABLE public.credit_purchase_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  stripe_price_id text NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(stripe_price_id)) BETWEEN 1 AND 255),
  stripe_session_id text NULL CHECK (stripe_session_id IS NULL OR pg_catalog.length(pg_catalog.btrim(stripe_session_id)) BETWEEN 1 AND 255),
  credits integer NOT NULL CHECK (credits IN (5, 10, 25)),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','consuming','consumed','released')),
  expires_at timestamptz NOT NULL,
  release_reason text NULL CHECK (release_reason IS NULL OR release_reason IN
    ('checkout_creation_failed','stripe_expired','stripe_expired_by_operator')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  consumed_at timestamptz NULL,
  released_at timestamptz NULL,
  CONSTRAINT credit_purchase_reservation_terminal_shape CHECK (
    (status = 'consumed' AND consumed_at IS NOT NULL AND released_at IS NULL AND release_reason IS NULL)
    OR (status = 'released' AND released_at IS NOT NULL AND consumed_at IS NULL AND release_reason IS NOT NULL)
    OR (status IN ('reserved','consuming') AND consumed_at IS NULL AND released_at IS NULL AND release_reason IS NULL)
  )
);

ALTER TABLE public.credit_purchase_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.credit_purchase_reservations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.credit_purchase_reservations TO service_role;

CREATE UNIQUE INDEX credit_purchase_reservations_session_uniq
  ON public.credit_purchase_reservations (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;
CREATE INDEX credit_purchase_reservations_active_user_idx
  ON public.credit_purchase_reservations (user_id)
  WHERE status = 'reserved';

COMMENT ON TABLE public.credit_purchase_reservations IS
  'Server-only capacity claims for one-time Stripe credit packs. A reserved row counts against the combined 50-credit cap until consumed or explicitly released after Stripe is known to be non-payable.';

CREATE OR REPLACE FUNCTION public.tg_enforce_credit_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_reserved integer;
BEGIN
  NEW.free_credits := COALESCE(NEW.free_credits, 0);
  NEW.premium_credits := COALESCE(NEW.premium_credits, 0);
  NEW.balance := NEW.free_credits + NEW.premium_credits;

  IF NEW.free_credits < 0 OR NEW.premium_credits < 0 THEN
    RAISE EXCEPTION 'credit_capacity: negative credit bucket';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.free_credits > 20 THEN
    RAISE EXCEPTION 'credit_capacity: included-credit cap exceeded';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.free_credits > 20
     AND NEW.free_credits > COALESCE(OLD.free_credits, 0) THEN
    RAISE EXCEPTION 'credit_capacity: legacy included balance may not increase';
  END IF;

  SELECT COALESCE(pg_catalog.sum(r.credits),0) INTO v_reserved
  FROM public.credit_purchase_reservations r
  WHERE r.user_id = NEW.user_id AND r.status = 'reserved';

  IF NEW.balance + v_reserved > 50 THEN
    RAISE EXCEPTION 'credit_capacity: combined credit capacity exceeded';
  END IF;
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.tg_enforce_credit_capacity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_enforce_credit_capacity() TO service_role;

DROP TRIGGER IF EXISTS enforce_credit_capacity ON public.meeting_credits;
CREATE TRIGGER enforce_credit_capacity
BEFORE INSERT OR UPDATE OF free_credits, premium_credits, balance ON public.meeting_credits
FOR EACH ROW EXECUTE FUNCTION public.tg_enforce_credit_capacity();

CREATE OR REPLACE FUNCTION public.reserve_credit_purchase(
  p_user_id uuid, p_price_id text, p_credits integer, p_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_mc public.meeting_credits; v_reserved integer; v_id uuid; v_headroom integer;
BEGIN
  IF p_user_id IS NULL OR p_price_id IS NULL OR pg_catalog.btrim(p_price_id) = ''
     OR pg_catalog.length(p_price_id) > 255 OR p_credits IS NULL OR p_credits NOT IN (5,10,25)
     OR p_expires_at IS NULL OR p_expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'reserve_credit_purchase: invalid argument';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 8901));
  SELECT * INTO v_mc FROM public.meeting_credits WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('outcome','credit_account_missing'); END IF;

  SELECT COALESCE(pg_catalog.sum(credits),0) INTO v_reserved
  FROM public.credit_purchase_reservations WHERE user_id=p_user_id AND status='reserved';
  v_headroom := GREATEST(0, 50 - COALESCE(v_mc.balance,0) - v_reserved);
  IF p_credits > v_headroom THEN
    RETURN pg_catalog.jsonb_build_object('outcome','at_capacity','headroom',v_headroom);
  END IF;

  INSERT INTO public.credit_purchase_reservations(user_id,stripe_price_id,credits,expires_at)
  VALUES (p_user_id,pg_catalog.btrim(p_price_id),p_credits,p_expires_at) RETURNING id INTO v_id;
  RETURN pg_catalog.jsonb_build_object('outcome','reserved','reservation_id',v_id,'headroom_after',v_headroom-p_credits);
END
$function$;

CREATE OR REPLACE FUNCTION public.bind_credit_purchase_reservation(
  p_reservation_id uuid, p_user_id uuid, p_session_id text, p_expires_at timestamptz
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_reservation_id IS NULL OR p_user_id IS NULL OR p_session_id IS NULL
     OR pg_catalog.btrim(p_session_id) = '' OR pg_catalog.length(p_session_id) > 255 OR p_expires_at IS NULL THEN
    RAISE EXCEPTION 'bind_credit_purchase_reservation: invalid argument';
  END IF;
  UPDATE public.credit_purchase_reservations
  SET stripe_session_id=pg_catalog.btrim(p_session_id), expires_at=p_expires_at, updated_at=pg_catalog.now()
  WHERE id=p_reservation_id AND user_id=p_user_id AND status='reserved' AND stripe_session_id IS NULL;
  IF FOUND THEN RETURN 'bound'; END IF;
  IF EXISTS (SELECT 1 FROM public.credit_purchase_reservations
             WHERE id=p_reservation_id AND user_id=p_user_id AND status='reserved'
               AND stripe_session_id=pg_catalog.btrim(p_session_id)) THEN RETURN 'already_bound'; END IF;
  RETURN 'conflict';
END
$function$;

CREATE OR REPLACE FUNCTION public.release_credit_purchase_reservation(
  p_reservation_id uuid, p_session_id text, p_reason text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v public.credit_purchase_reservations;
BEGIN
  IF p_reservation_id IS NULL OR p_reason NOT IN
    ('checkout_creation_failed','stripe_expired','stripe_expired_by_operator') THEN
    RAISE EXCEPTION 'release_credit_purchase_reservation: invalid argument';
  END IF;
  SELECT * INTO v FROM public.credit_purchase_reservations WHERE id=p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v.status='released' THEN RETURN 'already_released'; END IF;
  IF v.status<>'reserved' THEN RETURN 'conflict'; END IF;
  IF p_reason='checkout_creation_failed' THEN
    IF v.stripe_session_id IS NOT NULL OR p_session_id IS NOT NULL THEN RETURN 'conflict'; END IF;
  ELSE
    IF v.stripe_session_id IS NULL OR p_session_id IS NULL OR v.stripe_session_id<>pg_catalog.btrim(p_session_id) THEN
      RETURN 'conflict';
    END IF;
  END IF;
  UPDATE public.credit_purchase_reservations
  SET status='released', release_reason=p_reason, released_at=pg_catalog.now(), updated_at=pg_catalog.now()
  WHERE id=p_reservation_id;
  RETURN 'released';
END
$function$;

CREATE OR REPLACE FUNCTION public.grant_reserved_credit_pack(
  p_reservation_id uuid, p_event_id text, p_session_id text, p_user_id uuid,
  p_price_id text, p_credits integer, p_amount_total integer, p_currency text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v public.credit_purchase_reservations; v_currency text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_currency,'')));
BEGIN
  IF p_reservation_id IS NULL OR p_user_id IS NULL OR p_event_id IS NULL OR pg_catalog.btrim(p_event_id)=''
     OR p_session_id IS NULL OR pg_catalog.btrim(p_session_id)='' OR p_price_id IS NULL OR pg_catalog.btrim(p_price_id)=''
     OR p_credits IS NULL OR p_credits NOT IN (5,10,25) OR p_amount_total IS NULL OR p_amount_total<=0 OR v_currency<>'usd' THEN
    RAISE EXCEPTION 'grant_reserved_credit_pack: invalid argument';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 8901));
  SELECT * INTO v FROM public.credit_purchase_reservations WHERE id=p_reservation_id FOR UPDATE;
  IF NOT FOUND OR v.user_id<>p_user_id OR v.stripe_session_id IS DISTINCT FROM pg_catalog.btrim(p_session_id)
     OR v.stripe_price_id<>pg_catalog.btrim(p_price_id) OR v.credits<>p_credits THEN RETURN 'conflict'; END IF;
  IF v.status='consumed' THEN RETURN 'already_processed'; END IF;
  IF v.status<>'reserved' THEN RETURN 'conflict'; END IF;

  UPDATE public.credit_purchase_reservations SET status='consuming',updated_at=pg_catalog.now() WHERE id=v.id;
  BEGIN
    INSERT INTO public.credit_grants
      (user_id,stripe_event_id,stripe_session_id,stripe_price_id,credits,amount_total,currency)
    VALUES (p_user_id,pg_catalog.btrim(p_event_id),pg_catalog.btrim(p_session_id),pg_catalog.btrim(p_price_id),p_credits,p_amount_total,v_currency)
    ON CONFLICT (stripe_event_id) DO NOTHING;
  EXCEPTION WHEN unique_violation THEN
    IF EXISTS (SELECT 1 FROM public.credit_grants WHERE stripe_session_id=pg_catalog.btrim(p_session_id)) THEN
      UPDATE public.credit_purchase_reservations SET status='consumed',consumed_at=pg_catalog.now(),updated_at=pg_catalog.now() WHERE id=v.id;
      RETURN 'already_processed';
    END IF;
    RAISE;
  END;
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM public.credit_grants
                   WHERE stripe_event_id=pg_catalog.btrim(p_event_id)
                     AND stripe_session_id=pg_catalog.btrim(p_session_id)
                     AND user_id=p_user_id) THEN
      RAISE EXCEPTION 'grant_reserved_credit_pack: event id belongs to another grant';
    END IF;
    UPDATE public.credit_purchase_reservations SET status='consumed',consumed_at=pg_catalog.now(),updated_at=pg_catalog.now() WHERE id=v.id;
    RETURN 'already_processed';
  END IF;

  INSERT INTO public.meeting_credits(user_id,free_credits,premium_credits,balance,lifetime_earned)
  VALUES(p_user_id,0,p_credits,p_credits,p_credits)
  ON CONFLICT(user_id) DO UPDATE SET
    premium_credits=COALESCE(public.meeting_credits.premium_credits,0)+p_credits,
    balance=COALESCE(public.meeting_credits.free_credits,0)+COALESCE(public.meeting_credits.premium_credits,0)+p_credits,
    lifetime_earned=COALESCE(public.meeting_credits.lifetime_earned,0)+p_credits;

  UPDATE public.credit_purchase_reservations
  SET status='consumed',consumed_at=pg_catalog.now(),updated_at=pg_catalog.now() WHERE id=v.id;
  RETURN 'granted';
END
$function$;

CREATE OR REPLACE FUNCTION public.apply_credit_refill(
  p_user_id uuid, p_cycle_on date, p_lease_token uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_row public.membership_credit_cycles; v_current text; v_allowance int; v_next date;
  v_mc public.meeting_credits; v_reserved int; v_grant int;
BEGIN
  IF p_user_id IS NULL OR p_cycle_on IS NULL OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'apply_credit_refill: missing argument';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 8901));
  SELECT * INTO v_row FROM public.membership_credit_cycles WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_row.lease_token IS NULL OR v_row.lease_token<>p_lease_token
     OR v_row.lease_expires_at IS NULL OR v_row.lease_expires_at<pg_catalog.now() THEN RETURN 'stale_claim'; END IF;
  IF p_cycle_on<>v_row.next_refill_on THEN RETURN 'stale_claim'; END IF;
  IF v_row.next_refill_on>CURRENT_DATE THEN RETURN 'not_due'; END IF;

  SELECT public.effective_credit_tier(p.is_founding_member,p.founding_member_expires_at,p.subscription_tier)
  INTO v_current FROM public.profiles p WHERE p.id=p_user_id;
  IF v_current IS DISTINCT FROM v_row.claimed_tier THEN
    UPDATE public.membership_credit_cycles SET lease_token=NULL,lease_expires_at=NULL,claimed_tier=NULL,updated_at=pg_catalog.now()
    WHERE user_id=p_user_id;
    RETURN 'stale_claim';
  END IF;
  v_allowance:=public.tier_included_credits(v_row.claimed_tier);
  IF v_allowance IS NULL THEN RETURN 'invalid_tier'; END IF;
  v_next:=public.next_credit_refill_on(v_row.anchor_day,CURRENT_DATE);

  INSERT INTO public.credit_refills(user_id,cycle_on,tier,included_credits)
  VALUES(p_user_id,v_row.next_refill_on,v_row.claimed_tier,0)
  ON CONFLICT(user_id,cycle_on) DO NOTHING;
  IF NOT FOUND THEN
    UPDATE public.membership_credit_cycles SET next_refill_on=GREATEST(next_refill_on,v_next),
      lease_token=NULL,lease_expires_at=NULL,updated_at=pg_catalog.now() WHERE user_id=p_user_id;
    RETURN 'already_processed';
  END IF;

  SELECT * INTO v_mc FROM public.meeting_credits WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.meeting_credits(user_id,free_credits,premium_credits,balance,lifetime_earned)
    VALUES(p_user_id,0,0,0,0) RETURNING * INTO v_mc;
  END IF;
  SELECT COALESCE(pg_catalog.sum(credits),0) INTO v_reserved FROM public.credit_purchase_reservations
  WHERE user_id=p_user_id AND status='reserved';
  v_grant:=LEAST(v_allowance,
                 GREATEST(0,20-COALESCE(v_mc.free_credits,0)),
                 GREATEST(0,50-COALESCE(v_mc.balance,0)-v_reserved));

  UPDATE public.meeting_credits SET
    free_credits=COALESCE(free_credits,0)+v_grant,
    balance=COALESCE(free_credits,0)+v_grant+COALESCE(premium_credits,0),
    lifetime_earned=COALESCE(lifetime_earned,0)+v_grant
  WHERE user_id=p_user_id;
  UPDATE public.credit_refills SET included_credits=v_grant
  WHERE user_id=p_user_id AND cycle_on=v_row.next_refill_on;
  UPDATE public.membership_credit_cycles SET last_refill_on=v_row.next_refill_on,next_refill_on=v_next,
    last_tier=v_row.claimed_tier,lease_token=NULL,lease_expires_at=NULL,updated_at=pg_catalog.now() WHERE user_id=p_user_id;
  RETURN 'refilled';
END
$function$;

DO $cap_constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.meeting_credits'::regclass
                 AND conname='meeting_credits_combined_cap') THEN
    ALTER TABLE public.meeting_credits ADD CONSTRAINT meeting_credits_combined_cap
      CHECK (COALESCE(balance,0) <= 50);
  END IF;
END
$cap_constraint$;

REVOKE ALL ON FUNCTION public.reserve_credit_purchase(uuid,text,integer,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.bind_credit_purchase_reservation(uuid,uuid,text,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.release_credit_purchase_reservation(uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.grant_reserved_credit_pack(uuid,text,text,uuid,text,integer,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.apply_credit_refill(uuid,date,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_credit_purchase(uuid,text,integer,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_credit_purchase_reservation(uuid,uuid,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_credit_purchase_reservation(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.grant_reserved_credit_pack(uuid,text,text,uuid,text,integer,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_credit_refill(uuid,date,uuid) TO service_role;

COMMIT;
