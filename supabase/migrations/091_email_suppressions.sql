-- 091: EMAIL-KEYED UNSUBSCRIBE SUPPRESSIONS
--
-- Why a new table rather than notification_preferences.
--
-- notification_preferences (002) is keyed `user_id uuid PRIMARY KEY REFERENCES profiles(id)`.
-- It can only record a preference for someone who already has a profile row. The recipients whose
-- corporate gateways are penalizing us are precisely the ones who do NOT: invitees, nominees, and
-- waitlist entries. isPrefEnabled() looks the recipient up by email and RETURNS TRUE when no
-- profile exists, so today a cold invite recipient has no way to stop mail from us at all — which
-- is the substantive reason gateways weight List-Unsubscribe so heavily.
--
-- This table is therefore keyed by EMAIL, not user id, and is deliberately independent of
-- notification_preferences. A member who unsubscribes via a one-click header lands here; a member
-- who toggles a switch in settings still lands in notification_preferences. Both are consulted
-- before sending. Neither is rewritten in terms of the other, because they answer different
-- questions: "this address asked us to stop" vs "this member configured their notifications".
--
-- Append-mostly. An unsubscribe is recorded once per (email, category); re-clicking is a no-op via
-- ON CONFLICT. Resubscribing is a DELETE performed by the member from settings, not by the token.
CREATE TABLE IF NOT EXISTS public.email_suppressions (
  -- Lowercased at every write site. The address is the identity here; there may be no user.
  email        text        NOT NULL,

  -- One of the notification_preferences column names, or 'invitations' for the pre-account mail
  -- that has no preferences column, or 'all' for an explicit unsubscribe-from-everything.
  -- Free text rather than an enum so adding a mail category never needs a migration; the sender
  -- is the authority on which categories exist.
  category     text        NOT NULL,

  -- Provenance, so an operator can tell a one-click gateway unsubscribe from a deliberate one.
  source       text        NOT NULL DEFAULT 'one_click',

  created_at   timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (email, category)
);

-- The only read shape: "is this address suppressed for this category (or for 'all')?"
CREATE INDEX IF NOT EXISTS email_suppressions_email_idx
  ON public.email_suppressions (email);

ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;

-- No policies, and no privileges for the browser roles. This table is written by an
-- UNAUTHENTICATED route (one-click unsubscribe carries a signed token, not a session) and read by
-- the mail sender. Both run as service_role. Nothing in the browser touches it, so following 086's
-- discipline it gets no grants at all rather than a policy that would imply a session.
REVOKE ALL ON public.email_suppressions FROM PUBLIC;
REVOKE ALL ON public.email_suppressions FROM anon;
REVOKE ALL ON public.email_suppressions FROM authenticated;

-- No UPDATE: a suppression row is created or deleted, never edited. DELETE is retained so a member
-- can resubscribe from settings.
GRANT SELECT, INSERT, DELETE ON public.email_suppressions TO service_role;
