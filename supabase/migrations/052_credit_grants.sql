-- 052 — Durable, idempotent credit-pack grant ledger + atomic grant RPC.
--
-- WHY: Stripe credit-pack fulfillment previously trusted client-adjacent session metadata
-- (type=credit_purchase, credits=N) and clamped the grant to the monthly membership cap. A live
-- event whose metadata carried only supabase_user_id therefore granted ZERO credits, and even a
-- well-formed purchase could be silently truncated by the cap. This table + RPC make fulfillment:
--   • authoritative (credits resolved server-side from the Stripe Price ID, recorded here);
--   • idempotent per Stripe EVENT and per Checkout SESSION (either replay grants nothing more);
--   • atomic — the idempotency marker (this row) and the balance mutation commit in ONE transaction,
--     so a partial failure rolls back and the event stays safely retryable (never "processed" before
--     the grant is durable);
--   • uncapped for PURCHASED credits (premium_credits), while monthly/free credits keep their cap;
--   • null-safe against legacy meeting_credits rows (every existing numeric is COALESCEd).
--
-- Additive, idempotent, non-destructive. Service-role only (RLS on, NO policies). Stores only coarse
-- Stripe references + the granted amount — never card data, payment payloads, tokens, or email. No
-- credit expiry (there is no expires_at anywhere and purchased credits never expire).

CREATE TABLE IF NOT EXISTS public.credit_grants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- Dual idempotency keys: one Stripe EVENT and one Checkout SESSION may each grant at most once.
  stripe_event_id    text NOT NULL UNIQUE
                       CHECK (char_length(stripe_event_id) BETWEEN 1 AND 255),
  stripe_session_id  text NOT NULL UNIQUE
                       CHECK (char_length(stripe_session_id) BETWEEN 1 AND 255),
  stripe_price_id    text NOT NULL
                       CHECK (char_length(stripe_price_id) BETWEEN 1 AND 255),
  credits            integer NOT NULL CHECK (credits > 0 AND credits <= 100000),
  amount_total       integer NOT NULL CHECK (amount_total > 0),
  currency           text NOT NULL CHECK (currency = 'usd'), -- allow-list; current packs are USD only
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.credit_grants ENABLE ROW LEVEL SECURITY; -- service-role only; NO policies
REVOKE ALL ON public.credit_grants FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS credit_grants_user_idx ON public.credit_grants (user_id);

COMMENT ON TABLE public.credit_grants IS
  'Durable idempotent ledger of Stripe credit-pack grants. One grant per (stripe_event_id) and per (stripe_session_id). Service-role only.';

-- ── Atomic, idempotent, null-safe, input-hardened grant ────────────────────────────────
-- Records the grant marker AND mutates the balance in ONE transaction. Returns:
--   'granted'          — a NEW event+session; premium_credits/balance/lifetime_earned incremented by
--                        EXACTLY p_credits (purchased credits are NOT capped).
--   'already_processed'— the event OR the session already granted → ZERO additional credits.
-- Concurrent deliveries serialize on the unique indexes → exactly one 'granted'. A DB failure rolls
-- the whole thing back (no marker, no grant) so the caller can safely return a retryable error.
-- Inputs are validated defense-in-depth (blank/oversized ids, non-positive amount, currency allow-list)
-- even though only service_role may execute. The server remains authoritative for Price→pack mapping;
-- this function never maps a Price ID to a credit count.
CREATE OR REPLACE FUNCTION public.grant_credit_pack(
  p_event_id text,
  p_session_id text,
  p_user_id uuid,
  p_price_id text,
  p_credits integer,
  p_amount_total integer,
  p_currency text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_currency text := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_currency, '')));
BEGIN
  -- Reject NULL or BLANK identifiers (not only NULL).
  IF p_user_id IS NULL
     OR p_event_id IS NULL OR pg_catalog.btrim(p_event_id) = ''
     OR p_session_id IS NULL OR pg_catalog.btrim(p_session_id) = ''
     OR p_price_id IS NULL OR pg_catalog.btrim(p_price_id) = '' THEN
    RAISE EXCEPTION 'grant_credit_pack: missing or blank identifier';
  END IF;
  -- Bound identifier lengths (agree with the table CHECKs).
  IF pg_catalog.length(p_event_id) > 255 OR pg_catalog.length(p_session_id) > 255 OR pg_catalog.length(p_price_id) > 255 THEN
    RAISE EXCEPTION 'grant_credit_pack: identifier too long';
  END IF;
  IF p_credits IS NULL OR p_credits <= 0 OR p_credits > 100000 THEN
    RAISE EXCEPTION 'grant_credit_pack: invalid credit amount';
  END IF;
  IF p_amount_total IS NULL OR p_amount_total <= 0 THEN
    RAISE EXCEPTION 'grant_credit_pack: amount_total must be positive';
  END IF;
  IF v_currency <> 'usd' THEN
    RAISE EXCEPTION 'grant_credit_pack: unsupported currency';
  END IF;

  -- Claim the grant. ON CONFLICT (event) DO NOTHING handles a replayed EVENT; a duplicate SESSION
  -- under a DIFFERENT event id raises unique_violation on the session index → caught → already_processed.
  BEGIN
    INSERT INTO public.credit_grants
      (user_id, stripe_event_id, stripe_session_id, stripe_price_id, credits, amount_total, currency)
    VALUES
      (p_user_id, p_event_id, p_session_id, p_price_id, p_credits, p_amount_total, v_currency)
    ON CONFLICT (stripe_event_id) DO NOTHING;
  EXCEPTION WHEN unique_violation THEN
    RETURN 'already_processed'; -- this Checkout session was already granted under another event
  END;

  IF NOT FOUND THEN
    RETURN 'already_processed'; -- this event was already granted
  END IF;

  -- Durable grant, SAME transaction as the marker above. PURCHASED credits are never cap-clamped.
  -- NULL-SAFE: every existing numeric is COALESCEd so a legacy row with NULL free/premium/lifetime can
  -- never produce a NULL result. Balance is recomputed from the (coalesced) columns so the invariant
  -- balance = free_credits + premium_credits always holds. free_credits (the monthly pool) is only
  -- normalized to a non-null value here — its amount is otherwise untouched.
  INSERT INTO public.meeting_credits (user_id, free_credits, premium_credits, balance, lifetime_earned)
  VALUES (p_user_id, 0, p_credits, p_credits, p_credits)
  ON CONFLICT (user_id) DO UPDATE SET
    free_credits    = COALESCE(public.meeting_credits.free_credits, 0),
    premium_credits = COALESCE(public.meeting_credits.premium_credits, 0) + p_credits,
    balance         = COALESCE(public.meeting_credits.free_credits, 0)
                        + COALESCE(public.meeting_credits.premium_credits, 0) + p_credits,
    lifetime_earned = COALESCE(public.meeting_credits.lifetime_earned, 0) + p_credits;

  RETURN 'granted';
END;
$$;

REVOKE ALL ON FUNCTION public.grant_credit_pack(text, text, uuid, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.grant_credit_pack(text, text, uuid, text, integer, integer, text) TO service_role;
