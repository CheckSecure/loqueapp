-- 053 — Reliable monthly membership-credit replenishment on the signup ANNIVERSARY cycle.
--
-- WHAT: included/free credits refill to the tier allowance (Free 3 / Professional 10 / Executive 20 /
-- Founding 15) once per member per monthly anniversary of their signup date — REPLACING the included
-- balance (not stacking). Purchased (premium) credits are never touched. This is the SOLE recurring
-- included-credit refill authority (the Stripe subscription webhook no longer mutates credits).
--
-- TIER-BOUND (final integrity fix): the member's AUTHORITATIVE effective tier is resolved SERVER-SIDE
-- at CLAIM time (public.effective_credit_tier, an exact mirror of the app's getEffectiveTier) and
-- STORED on the cycle row as claimed_tier. apply_credit_refill takes NO tier argument — it uses the
-- stored claimed_tier, and re-resolves the CURRENT effective tier inside the transaction: if the
-- profile's tier drifted since the claim, it REJECTS (stale_claim) and releases the lease so a reclaim
-- re-snapshots the current tier. A caller therefore cannot substitute Free→Professional/Executive/
-- Founding between claim and apply. The DB derives the allowance from the stored tier.
--
-- HARDENING: apply is cycle-bound (supplied cycle must equal stored next_refill_on), due-bound, and
-- lease-owned (matching unexpired lease token); ledger insert + credit update + cycle advance are ONE
-- transaction (a DB failure rolls all of it back). Unknown/inconsistent tiers are PARKED
-- (status='needs_review') — no grant, excluded from future claims, visible to operators.
--
-- SAFETY: additive, idempotent, non-destructive (safe applied fresh; 053 not previously applied).
-- Service-role only (RLS on, zero policies, EXECUTE revoked from PUBLIC/anon/authenticated). Does NOT
-- touch migration 052 (credit_grants / grant_credit_pack) or purchased credits. Existing members are
-- backfilled to their NEXT FUTURE anniversary → no retroactive/multiple historical grants. UTC dates.

-- ── DB-authoritative tier allowance (never a caller-supplied amount) ───────────────────────
CREATE OR REPLACE FUNCTION public.tier_included_credits(p_tier text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE p_tier
    WHEN 'free' THEN 3
    WHEN 'professional' THEN 10
    WHEN 'executive' THEN 20
    WHEN 'founding' THEN 15
    ELSE NULL
  END;
$$;

-- ── Authoritative effective tier — EXACT mirror of lib/tier-override.ts getEffectiveTier ──────
--   founding member with no/future expiry            → 'founding'
--   founding member whose founding_member_expires_at < now → falls back to the subscription tier
--   otherwise                                        → subscription_tier (or 'free' when null/empty)
-- Subscription STATUS is already baked into subscription_tier by the Stripe webhook (active→tier, else
-- 'free'), exactly as getEffectiveTier consumes it. An unrecognized subscription_tier passes through
-- verbatim so tier_included_credits returns NULL → the member is parked (never silently defaulted).
CREATE OR REPLACE FUNCTION public.effective_credit_tier(
  p_is_founding boolean, p_founding_expires timestamptz, p_subscription_tier text
) RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
BEGIN
  IF p_is_founding THEN
    IF p_founding_expires IS NOT NULL AND p_founding_expires < pg_catalog.now() THEN
      RETURN COALESCE(NULLIF(p_subscription_tier, ''), 'free');
    END IF;
    RETURN 'founding';
  END IF;
  RETURN COALESCE(NULLIF(p_subscription_tier, ''), 'free');
END;
$$;

-- ── Clamp-safe anniversary math: first monthly anniversary of an anchor day STRICTLY AFTER p_after ──
-- Day 31 anchors clamp to the month's last day (Feb→28/29, leap-safe). Mirrors JS nextCreditRefillOn.
CREATE OR REPLACE FUNCTION public.next_credit_refill_on(p_anchor_day integer, p_after date)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_anchor int := GREATEST(1, LEAST(31, COALESCE(p_anchor_day, 1)));
  v_month_start date;
  v_cand date;
  i int;
BEGIN
  FOR i IN 0..2 LOOP
    v_month_start := pg_catalog.date_trunc('month', (p_after + (i || ' months')::interval))::date;
    v_cand := v_month_start
      + (LEAST(v_anchor, pg_catalog.date_part('day', (v_month_start + INTERVAL '1 month - 1 day'))::int) - 1);
    IF v_cand > p_after THEN
      RETURN v_cand;
    END IF;
  END LOOP;
  RETURN v_cand;
END;
$$;

-- ── Per-user cycle marker (durable idempotency driver + lease ownership + claimed tier snapshot) ──
CREATE TABLE IF NOT EXISTS public.membership_credit_cycles (
  user_id           uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  anchor_day        smallint NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  next_refill_on    date NOT NULL,
  last_refill_on    date NULL,
  last_tier         text NULL,
  claimed_tier      text NULL,   -- authoritative effective tier snapshot at claim time (server-resolved)
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_review')),
  lease_token       uuid NULL,
  lease_expires_at  timestamptz NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.membership_credit_cycles ENABLE ROW LEVEL SECURITY; -- service-role only; NO policies
REVOKE ALL ON public.membership_credit_cycles FROM PUBLIC, anon, authenticated;
-- Idempotent adds for a pre-existing table from an earlier draft.
ALTER TABLE public.membership_credit_cycles ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE public.membership_credit_cycles ADD COLUMN IF NOT EXISTS lease_token uuid NULL;
ALTER TABLE public.membership_credit_cycles ADD COLUMN IF NOT EXISTS claimed_tier text NULL;
CREATE INDEX IF NOT EXISTS membership_cycles_due_idx ON public.membership_credit_cycles (next_refill_on) WHERE status = 'active';

-- ── Append-only refill ledger — HARD at-most-once per (user, cycle) ────────────────────────
CREATE TABLE IF NOT EXISTS public.credit_refills (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  cycle_on          date NOT NULL,
  tier              text NOT NULL CHECK (tier IN ('free','professional','executive','founding')),
  included_credits  integer NOT NULL CHECK (included_credits >= 0 AND included_credits <= 100000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_refills_once UNIQUE (user_id, cycle_on)
);
ALTER TABLE public.credit_refills ENABLE ROW LEVEL SECURITY; -- service-role only; NO policies
REVOKE ALL ON public.credit_refills FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS credit_refills_user_idx ON public.credit_refills (user_id);

-- ── Auto-enroll every NEW member (schedule only; the initial grant stays in onboarding code) ──
CREATE OR REPLACE FUNCTION public.enroll_membership_credit_cycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_anchor int := GREATEST(1, LEAST(31, pg_catalog.date_part('day', COALESCE(NEW.created_at, pg_catalog.now()))::int));
  v_from date := (COALESCE(NEW.created_at, pg_catalog.now()))::date;
BEGIN
  INSERT INTO public.membership_credit_cycles (user_id, anchor_day, next_refill_on)
  VALUES (NEW.id, v_anchor, public.next_credit_refill_on(v_anchor, v_from))
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enroll_membership_credit_cycle ON public.profiles;
CREATE TRIGGER trg_enroll_membership_credit_cycle
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.enroll_membership_credit_cycle();

-- ── Backfill EXISTING members → NEXT FUTURE anniversary (no retroactive/multiple historical grants) ──
INSERT INTO public.membership_credit_cycles (user_id, anchor_day, next_refill_on)
SELECT p.id,
       GREATEST(1, LEAST(31, pg_catalog.date_part('day', p.created_at)::int)),
       public.next_credit_refill_on(pg_catalog.date_part('day', p.created_at)::int, CURRENT_DATE)
FROM public.profiles p
WHERE p.created_at IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

-- ── Atomic claim: lease TOKEN + AUTHORITATIVE tier snapshot (bounded, concurrent-safe, active-only) ──
CREATE OR REPLACE FUNCTION public.claim_due_credit_refills(p_limit integer, p_lease_seconds integer)
RETURNS TABLE(user_id uuid, cycle_on date, lease_token uuid, claimed_tier text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT s.user_id
    FROM public.membership_credit_cycles s
    WHERE s.status = 'active'
      AND s.next_refill_on <= CURRENT_DATE
      AND (s.lease_expires_at IS NULL OR s.lease_expires_at < pg_catalog.now())
    ORDER BY s.next_refill_on ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 0), 0), 200)
    FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE public.membership_credit_cycles c
    SET lease_token = gen_random_uuid(),   -- VOLATILE → a distinct ownership token PER claimed row
        lease_expires_at = pg_catalog.now()
          + pg_catalog.make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 1), 3600)),
        claimed_tier = public.effective_credit_tier(p.is_founding_member, p.founding_member_expires_at, p.subscription_tier),
        updated_at = pg_catalog.now()
    FROM public.profiles p
    WHERE c.user_id = p.id AND c.user_id IN (SELECT d.user_id FROM due d)
    RETURNING c.user_id, c.next_refill_on, c.lease_token, c.claimed_tier
  )
  SELECT cl.user_id, cl.next_refill_on, cl.lease_token, cl.claimed_tier FROM claimed cl;
END;
$$;

-- ── Atomic apply: TIER-BOUND, cycle-bound, lease-owned, DB-derived amount/date, one transaction ────
-- Signature takes NO tier — the allowance is derived from the STORED claimed_tier. Returns:
-- 'refilled' | 'already_processed' | 'stale_claim' | 'not_due' | 'invalid_tier'. If the member's
-- current effective tier has drifted from the claimed snapshot, it REJECTS (stale_claim) and releases
-- the lease so a reclaim uses the current authoritative tier. Premium credits preserved EXACTLY.
CREATE OR REPLACE FUNCTION public.apply_credit_refill(
  p_user_id uuid, p_cycle_on date, p_lease_token uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.membership_credit_cycles;
  v_current text;
  v_included int;
  v_next date;
BEGIN
  IF p_user_id IS NULL OR p_cycle_on IS NULL OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'apply_credit_refill: missing argument';
  END IF;

  SELECT * INTO v_row FROM public.membership_credit_cycles WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale_claim'; END IF;

  -- Ownership: this worker must hold the CURRENT, UNEXPIRED lease (a newer claim rotates the token).
  IF v_row.lease_token IS NULL OR v_row.lease_token <> p_lease_token
     OR v_row.lease_expires_at IS NULL OR v_row.lease_expires_at < pg_catalog.now() THEN
    RETURN 'stale_claim';
  END IF;

  -- The claimed cycle must equal the stored schedule (rejects fabricated/stale/future/mismatched).
  IF p_cycle_on <> v_row.next_refill_on THEN RETURN 'stale_claim'; END IF;
  IF v_row.next_refill_on > CURRENT_DATE THEN RETURN 'not_due'; END IF;

  -- TIER BINDING: re-resolve the CURRENT authoritative tier; if it drifted from the claimed snapshot,
  -- reject and release the lease so a reclaim re-snapshots (the anniversary uses the current tier).
  SELECT public.effective_credit_tier(pr.is_founding_member, pr.founding_member_expires_at, pr.subscription_tier)
    INTO v_current FROM public.profiles pr WHERE pr.id = p_user_id;
  IF v_current IS DISTINCT FROM v_row.claimed_tier THEN
    UPDATE public.membership_credit_cycles
    SET lease_token = NULL, lease_expires_at = NULL, claimed_tier = NULL, updated_at = pg_catalog.now()
    WHERE user_id = p_user_id;
    RETURN 'stale_claim';
  END IF;

  -- DB-authoritative allowance from the STORED tier (never a caller amount). Unknown snapshot → invalid.
  v_included := public.tier_included_credits(v_row.claimed_tier);
  IF v_included IS NULL THEN RETURN 'invalid_tier'; END IF;

  v_next := public.next_credit_refill_on(v_row.anchor_day, CURRENT_DATE);

  -- HARD idempotency per (user, cycle).
  INSERT INTO public.credit_refills (user_id, cycle_on, tier, included_credits)
  VALUES (p_user_id, v_row.next_refill_on, v_row.claimed_tier, v_included)
  ON CONFLICT (user_id, cycle_on) DO NOTHING;

  IF NOT FOUND THEN
    -- Already granted this cycle → clear lease + advance schedule, no credit change.
    UPDATE public.membership_credit_cycles
    SET next_refill_on = GREATEST(next_refill_on, v_next),
        lease_token = NULL, lease_expires_at = NULL, updated_at = pg_catalog.now()
    WHERE user_id = p_user_id;
    RETURN 'already_processed';
  END IF;

  -- REPLACE included/free credits to the allowance; PRESERVE premium exactly; null-safe balance.
  INSERT INTO public.meeting_credits (user_id, free_credits, premium_credits, balance, lifetime_earned)
  VALUES (p_user_id, v_included, 0, v_included, v_included)
  ON CONFLICT (user_id) DO UPDATE SET
    free_credits = v_included,
    balance      = v_included + COALESCE(public.meeting_credits.premium_credits, 0);

  UPDATE public.membership_credit_cycles
  SET last_refill_on = v_row.next_refill_on, next_refill_on = v_next, last_tier = v_row.claimed_tier,
      lease_token = NULL, lease_expires_at = NULL, updated_at = pg_catalog.now()
  WHERE user_id = p_user_id;

  RETURN 'refilled';
END;
$$;

-- ── Park an unknown/inconsistent-tier cycle for operator review (grants nothing, no hot loop) ──
-- Returns 'parked' | 'stale_claim'. Requires lease ownership + a matching due cycle. status becomes
-- 'needs_review' → excluded from future claims (visible via a status query) until an operator resets it.
CREATE OR REPLACE FUNCTION public.park_credit_cycle(
  p_user_id uuid, p_cycle_on date, p_lease_token uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.membership_credit_cycles;
BEGIN
  IF p_user_id IS NULL OR p_cycle_on IS NULL OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'park_credit_cycle: missing argument';
  END IF;
  SELECT * INTO v_row FROM public.membership_credit_cycles WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale_claim'; END IF;
  IF v_row.lease_token IS NULL OR v_row.lease_token <> p_lease_token
     OR v_row.lease_expires_at IS NULL OR v_row.lease_expires_at < pg_catalog.now()
     OR p_cycle_on <> v_row.next_refill_on THEN
    RETURN 'stale_claim';
  END IF;
  UPDATE public.membership_credit_cycles
  SET status = 'needs_review', lease_token = NULL, lease_expires_at = NULL, updated_at = pg_catalog.now()
  WHERE user_id = p_user_id;
  RETURN 'parked';
END;
$$;

-- ── Privileges: EXECUTE for service_role ONLY (trigger fn needs no grant — trigger exec bypasses it) ──
REVOKE ALL ON FUNCTION public.tier_included_credits(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tier_included_credits(text) TO service_role;
REVOKE ALL ON FUNCTION public.effective_credit_tier(boolean, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.effective_credit_tier(boolean, timestamptz, text) TO service_role;
REVOKE ALL ON FUNCTION public.next_credit_refill_on(integer, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_credit_refill_on(integer, date) TO service_role;
REVOKE ALL ON FUNCTION public.enroll_membership_credit_cycle() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_due_credit_refills(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_credit_refills(integer, integer) TO service_role;
REVOKE ALL ON FUNCTION public.apply_credit_refill(uuid, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_credit_refill(uuid, date, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.park_credit_cycle(uuid, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.park_credit_cycle(uuid, date, uuid) TO service_role;

-- The enrollment trigger function is invoked ONLY by the AFTER INSERT trigger (trigger execution
-- bypasses EXECUTE privilege checks), so no role needs direct EXECUTE. Explicitly revoke it from
-- service_role too so NO role can call it directly — matching production's final state.
REVOKE ALL ON FUNCTION public.enroll_membership_credit_cycle() FROM service_role;
