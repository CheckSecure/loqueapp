-- 055 — Durable P0 containment: revoke browser-role DML on core member tables.
--
-- WHY: the browser ships the Supabase anon key + URL, so an authenticated member can call PostgREST
-- (`/rest/v1/<table>`) directly from the console as the `authenticated` role. Several core tables had
-- their DML reachable that way (relying only on RLS/permissive policies), which allowed console-forged
-- writes: forged messages, forged/edited meetings, arbitrary credit_transactions, forged matches/
-- conversations/intro_requests, and direct profile column writes (e.g. is_admin / subscription_tier /
-- password_reset_required). Production privileges were already revoked manually and verified; this
-- migration makes that containment permanent and version-controlled.
--
-- MODEL: browser (anon/authenticated) keeps SELECT (row visibility is governed by existing RLS) and the
-- recipient-only message read-state UPDATE. Every INSERT/UPDATE/DELETE that the app legitimately needs
-- on these tables now runs SERVER-SIDE through `service_role` AFTER getUser()-based authorization (see
-- the accompanying route/action changes). service_role bypasses RLS and retains all privileges.
--
-- Idempotent · additive · re-runnable · matches the already-applied production containment.
-- Does NOT touch migration 048, does NOT begin the A3 profiles column-privacy read migration, and does
-- NOT revoke SELECT or the messages read-state UPDATE.

-- ── profiles: revoke INSERT + UPDATE (all profile writes go through server routes now) ──────────────
REVOKE INSERT, UPDATE ON TABLE public.profiles FROM PUBLIC, anon, authenticated;

-- ── messages: revoke INSERT + DELETE; KEEP UPDATE (recipient read-state marking stays a browser write)
REVOKE INSERT, DELETE ON TABLE public.messages FROM PUBLIC, anon, authenticated;

-- ── meetings / credit_transactions / matches / conversations / intro_requests: revoke all DML ────────
REVOKE INSERT, UPDATE, DELETE ON TABLE public.meetings           FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.credit_transactions FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.matches            FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.conversations      FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.intro_requests     FROM PUBLIC, anon, authenticated;

-- ── Explicitly PRESERVE service_role management privileges (idempotent; unaffected by the revokes) ──
-- The server (createAdminClient) performs every legitimate mutation as service_role after authorization.
GRANT INSERT, UPDATE, DELETE ON TABLE public.profiles            TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.messages            TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.meetings            TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.credit_transactions TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.matches            TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.conversations      TO service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.intro_requests     TO service_role;

-- ── Neutralize the now-obsolete permissive mutation policies ────────────────────────────────────────
-- Once the underlying privilege is revoked, a permissive INSERT/UPDATE/DELETE policy is UNREACHABLE (a
-- policy can never grant a privilege the role does not hold). Dropping the known ones removes dead,
-- misleading grants. Any other out-of-band mutation policy on these tables is likewise inert.
-- SELECT policies and the recipient-only message read-state UPDATE policy are intentionally left intact.
DROP POLICY IF EXISTS profiles_insert_system         ON public.profiles;
DROP POLICY IF EXISTS messages_insert_authenticated  ON public.messages;
DROP POLICY IF EXISTS meetings_insert_authenticated  ON public.meetings;
DROP POLICY IF EXISTS credit_tx_insert_system        ON public.credit_transactions;
