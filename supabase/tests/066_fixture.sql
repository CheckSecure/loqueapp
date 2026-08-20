-- 066_fixture.sql — expiry harness support. Loaded after 063/064 fixtures.
ALTER TABLE public.member_pairs ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.intro_requests ADD COLUMN IF NOT EXISTS expired_at timestamptz;

CREATE TABLE IF NOT EXISTS public.reminder_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  purpose             text NOT NULL CHECK (purpose IN ('wednesday_intro_reminder')),
  cycle_key           text NOT NULL,
  open_card_count     integer NOT NULL DEFAULT 0 CHECK (open_card_count >= 0),
  provider_message_id text NULL,
  status              text NOT NULL DEFAULT 'claimed'
                       CHECK (status IN ('claimed','accepted','delivered','deferred',
                                         'bounced','blocked','complained','failed')),
  error_class         text NULL,
  claimed_at          timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reminder_deliveries_active_claim_uniq
  ON public.reminder_deliveries (member_id, purpose, cycle_key)
  WHERE status IN ('claimed', 'accepted', 'delivered', 'deferred');

CREATE OR REPLACE FUNCTION public.t_reset066() RETURNS void LANGUAGE sql AS $$
  TRUNCATE public.reminder_deliveries CASCADE;
  SELECT public.t_reset064();
$$;

-- ── Support for the finalization-vs-expiry race harness ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- ── Tables the delegate writes ──────────────────────────────────────────────────────────────────
--
-- The FUNCTION public.consume_credits_and_create_match is deliberately NOT defined here. It is
-- created by migration 067 from the operator's pg_get_functiondef output, and the bootstrap loads
-- 067 after this file. A fixture copy would be an approximation that drifts from the migration and
-- would let the harness "prove" behaviour the real function does not have. The harness must exercise
-- the definition that is actually going to be applied to production, so it gets exactly that.
--
-- Only the tables it touches are stubbed, because this repository does not own them.
-- Column shapes follow migrations 052/053, which maintain balance = free_credits + premium_credits.
CREATE TABLE IF NOT EXISTS public.meeting_credits (
  user_id         uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  free_credits    integer NOT NULL DEFAULT 0,
  premium_credits integer NOT NULL DEFAULT 0,
  balance         integer NOT NULL DEFAULT 0,
  lifetime_earned integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION public.t_reset067() RETURNS void LANGUAGE sql AS $$
  TRUNCATE public.conversations CASCADE;
  DELETE FROM public.meeting_credits;
  INSERT INTO public.meeting_credits (user_id, free_credits, premium_credits, balance)
    SELECT id, 5, 0, 5 FROM public.profiles;
  SELECT public.t_reset066();
$$;
