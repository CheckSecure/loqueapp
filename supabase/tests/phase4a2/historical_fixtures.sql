-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- PHASE 4A-2 HARNESS — HISTORICAL FIXTURES
--
-- LOADED BEFORE MIGRATION 100. That ordering is the whole point, not a convenience: production had
-- 139 profiles when migration 100 was written, and some of them predate the invitation architecture
-- entirely. Seeding them first is what makes cases 12, 13 and 22 real measurements instead of
-- assumptions — a fixture created after the trigger would have had to satisfy it, which is precisely
-- the property under test.
--
-- Nothing here is production data. No address, name or company below belongs to a real person, and
-- no Next member exists in production.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════

-- ── auth identities for the historical members ───────────────────────────────────────────────
INSERT INTO auth.users (id, email) VALUES
 ('a0000001-0000-4000-8000-000000000001', 'hist.ordinary@example.test'),
 ('a0000002-0000-4000-8000-000000000002', 'hist.nowaitlist@example.test');
-- hist.noauth deliberately has NO auth.users row: the second known legacy shape.

-- ── their invitations ────────────────────────────────────────────────────────────────────────
-- Only the ordinary member has one. The other two are the legacy exceptions the Phase 4A audit
-- found in production: profiles with no qualifying waitlist history.
INSERT INTO public.waitlist (id, email, full_name, status, invited_at) VALUES
 ('b0000001-0000-4000-8000-000000000001', 'hist.ordinary@example.test', 'Hist Ordinary', 'invited', now());

-- ── the profiles themselves ──────────────────────────────────────────────────────────────────
-- member_type is written EXPLICITLY here. At this point migration 095's DEFAULT still exists and
-- migration 100 has not been loaded, so these inserts are exactly what production's historical rows
-- were: created before any binding existed.
INSERT INTO public.profiles (id, email, full_name, member_type, profile_complete) VALUES
 ('a0000001-0000-4000-8000-000000000001', 'hist.ordinary@example.test',   'Hist Ordinary',    'professional', true),
 ('a0000002-0000-4000-8000-000000000002', 'hist.nowaitlist@example.test', 'Hist No Waitlist', 'professional', true),
 ('a0000003-0000-4000-8000-000000000003', 'hist.noauth@example.test',     'Hist No Auth',     'professional', true);


-- ═══ CANDIDATES FOR PROVISIONING — auth identity and invitation only, NO profile ═══════════════
-- Every row below exists so that a case AFTER migration 100 can attempt a first insert for it.

-- P1  ordinary Professional invitation → must succeed and receive 'professional'
INSERT INTO auth.users (id, email) VALUES ('c0000001-0000-4000-8000-000000000001', 'cand.pro@example.test');
INSERT INTO public.waitlist (email, full_name, status, invited_at)
  VALUES ('cand.pro@example.test', 'Cand Pro', 'invited', now());

-- P2  a NEXT invitation → must succeed and receive 'next'. This is the first and only place in the
--     repository where intended_member_type is set to 'next', and it is a disposable local cluster.
INSERT INTO auth.users (id, email) VALUES ('c0000002-0000-4000-8000-000000000002', 'cand.next@example.test');
INSERT INTO public.waitlist (email, full_name, status, invited_at, intended_member_type)
  VALUES ('cand.next@example.test', 'Cand Next', 'invited', now(), 'next');

-- P3  auth identity, no invitation at all → waitlist_absent
INSERT INTO auth.users (id, email) VALUES ('c0000003-0000-4000-8000-000000000003', 'cand.nowl@example.test');

-- P4/P5  terminal invitation states → refused
INSERT INTO auth.users (id, email) VALUES ('c0000004-0000-4000-8000-000000000004', 'cand.revoked@example.test');
INSERT INTO public.waitlist (email, full_name, status, revoked_at)
  VALUES ('cand.revoked@example.test', 'Cand Revoked', 'revoked', now());
INSERT INTO auth.users (id, email) VALUES ('c0000005-0000-4000-8000-000000000005', 'cand.declined@example.test');
INSERT INTO public.waitlist (email, full_name, status)
  VALUES ('cand.declined@example.test', 'Cand Declined', 'declined');

-- P6/P7/P8  THE PRE-INVITATION STATES — case 27.
-- 099's resolver returns resolved/professional for every one of these, because it excludes only
-- 'revoked'. may_provision_profile must refuse all three anyway. This is the separation of
-- "which community" from "may they provision" made measurable.
INSERT INTO auth.users (id, email) VALUES ('c0000006-0000-4000-8000-000000000006', 'cand.pending@example.test');
INSERT INTO public.waitlist (email, full_name, status)
  VALUES ('cand.pending@example.test', 'Cand Pending', 'pending');
INSERT INTO auth.users (id, email) VALUES ('c0000007-0000-4000-8000-000000000007', 'cand.approved@example.test');
INSERT INTO public.waitlist (email, full_name, status)
  VALUES ('cand.approved@example.test', 'Cand Approved', 'approved');
INSERT INTO auth.users (id, email) VALUES ('c0000008-0000-4000-8000-000000000008', 'cand.contacted@example.test');
INSERT INTO public.waitlist (email, full_name, status)
  VALUES ('cand.contacted@example.test', 'Cand Contacted', 'contacted');

-- P9  AMBIGUOUS INTENT.
-- Migration 009's unique index is on lower(email) while 078's resolvers normalise with
-- lower(btrim(...)), so ' cand.amb@example.test' and 'cand.amb@example.test' are two rows to the
-- index and one person to every resolver. That gap is exactly what 099's conflicting-intent trigger
-- exists to close, so the trigger has to be lifted to plant the row — the same technique the 4A-1
-- harness used to prove the resolver still answers 'ambiguous' when issuance protection is absent.
INSERT INTO auth.users (id, email) VALUES ('c0000009-0000-4000-8000-000000000009', 'cand.amb@example.test');
ALTER TABLE public.waitlist DISABLE TRIGGER waitlist_intent_no_conflict_biu;
INSERT INTO public.waitlist (email, full_name, status, invited_at, intended_member_type) VALUES
 ('cand.amb@example.test',  'Cand Amb A', 'invited', now(), 'professional'),
 (' cand.amb@example.test', 'Cand Amb B', 'invited', now(), 'next');
ALTER TABLE public.waitlist ENABLE TRIGGER waitlist_intent_no_conflict_biu;

-- P10  two waitlist rows, SAME intent — not ambiguous to the resolver, still a duplicate identity.
INSERT INTO auth.users (id, email) VALUES ('c0000010-0000-4000-8000-000000000010', 'cand.dup@example.test');
INSERT INTO public.waitlist (email, full_name, status, invited_at) VALUES
 ('cand.dup@example.test',  'Cand Dup A', 'invited', now()),
 (' cand.dup@example.test', 'Cand Dup B', 'invited', now());

-- P11  two auth identities at one address → identity_ambiguous
INSERT INTO auth.users (id, email) VALUES
 ('c0000011-0000-4000-8000-000000000011', 'cand.twoauth@example.test'),
 ('c0000012-0000-4000-8000-000000000012', ' cand.twoauth@example.test');
INSERT INTO public.waitlist (email, full_name, status, invited_at)
  VALUES ('cand.twoauth@example.test', 'Cand Two Auth', 'invited', now());

-- P12  a perfectly good invitation whose address belongs to a DIFFERENT auth user → identity_mismatch
INSERT INTO auth.users (id, email) VALUES ('c0000013-0000-4000-8000-000000000013', 'cand.mismatch@example.test');
INSERT INTO public.waitlist (email, full_name, status, invited_at)
  VALUES ('cand.mismatch@example.test', 'Cand Mismatch', 'invited', now());

-- P13  a second authorized Professional, used by the credit-cycle and stamp cases so they never
--      depend on another case having run first.
INSERT INTO auth.users (id, email) VALUES ('c0000014-0000-4000-8000-000000000014', 'cand.credit@example.test');
INSERT INTO public.waitlist (email, full_name, status, invited_at)
  VALUES ('cand.credit@example.test', 'Cand Credit', 'invited', now());

-- P14  authorized, used for the "explicit matching member_type" case.
INSERT INTO auth.users (id, email) VALUES ('c0000015-0000-4000-8000-000000000015', 'cand.explicit@example.test');
INSERT INTO public.waitlist (email, full_name, status, invited_at)
  VALUES ('cand.explicit@example.test', 'Cand Explicit', 'invited', now());

-- P15  authorized, used for the "explicit MISMATCHED member_type" case.
INSERT INTO auth.users (id, email) VALUES ('c0000016-0000-4000-8000-000000000016', 'cand.wrongtype@example.test');
INSERT INTO public.waitlist (email, full_name, status, invited_at)
  VALUES ('cand.wrongtype@example.test', 'Cand Wrong Type', 'invited', now());

-- P16  authorized, used for the service_role bypass case.
INSERT INTO auth.users (id, email) VALUES ('c0000017-0000-4000-8000-000000000017', 'cand.svcrole@example.test');
-- deliberately NO waitlist row: service_role must be refused exactly like anyone else.
