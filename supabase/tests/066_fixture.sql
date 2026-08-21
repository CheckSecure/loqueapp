-- 066_fixture.sql — expiry harness support. Loaded after 063/064 fixtures.
ALTER TABLE public.member_pairs ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.intro_requests ADD COLUMN IF NOT EXISTS expired_at timestamptz;
-- Production's matches table carries admin_notes (written by adminForceMatch and simulate-matches).
-- The credit reconciliation audit uses its presence as a shape hint for direct-insert admin paths,
-- so the fixture must have it or the audit cannot be exercised here.
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS admin_notes text;

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
-- Inflow ledgers (052/053) and the targeted-request table, so the credit audits can EXECUTE here
-- rather than only parse. Shapes follow the real migrations.
CREATE TABLE IF NOT EXISTS public.credit_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  credits integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.credit_refills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  included_credits integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.targeted_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The general credit movement log. Created OUT OF BAND in production (it appears in no migration),
-- so the columns here are the ones the application actually writes. Migration 072 extends it with
-- event_key / source_kind / source_id and makes ledgered rows append-only.
CREATE TABLE IF NOT EXISTS public.credit_transactions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  amount       integer NOT NULL,
  type         text NULL,
  note         text NULL,
  description  text NULL,
  reference_id uuid NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Supabase grants roles broad table access at CREATE TABLE time via ALTER DEFAULT PRIVILEGES. A
-- plain local cluster does not, which is precisely why migration 072 looked correct here while
-- production had inherited privileges it never named. The harness models the production starting
-- point so 073 is tested against the state it was actually written for: authenticated keeps SELECT
-- (a member may read their own credit history through RLS); every mutation verb is revoked by 073.
GRANT SELECT ON TABLE public.credit_transactions TO authenticated;

CREATE TABLE IF NOT EXISTS public.meeting_credits (
  user_id         uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  free_credits    integer NOT NULL DEFAULT 0,
  premium_credits integer NOT NULL DEFAULT 0,
  balance         integer NOT NULL DEFAULT 0,
  lifetime_earned integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION public.t_reset067() RETURNS void LANGUAGE sql AS $$
  TRUNCATE public.conversations CASCADE;
  -- TRUNCATE, not DELETE: migration 072 makes ledgered rows append-only via a ROW trigger, which
  -- correctly refuses a DELETE. Row triggers do not fire on TRUNCATE, so the disposable fixture can
  -- still reset without weakening the production guarantee.
  TRUNCATE public.credit_transactions CASCADE;
  TRUNCATE public.credit_grants, public.credit_refills, public.targeted_requests CASCADE;
  DELETE FROM public.meeting_credits;
  INSERT INTO public.meeting_credits (user_id, free_credits, premium_credits, balance)
    SELECT id, 5, 0, 5 FROM public.profiles;
  SELECT public.t_reset066();
$$;
