-- Andrel | waitlist launch announcement tracking | 2026-06-08
ALTER TABLE public.waitlist
  ADD COLUMN IF NOT EXISTS launch_announcement_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS launch_announcement_email_error text;
