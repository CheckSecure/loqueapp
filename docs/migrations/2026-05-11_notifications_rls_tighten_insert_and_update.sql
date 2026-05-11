-- 2026-05-11: Tighten notifications RLS — drop loose INSERT, add WITH CHECK to UPDATE
--
-- STATE FOUND ON 2026-05-11 (pre-apply, confirmed via SQL editor inspection):
--   relrowsecurity = true on public.notifications
--   "Users can view own notifications"   — SELECT, USING (user_id = auth.uid())
--   "Users can update own notifications" — UPDATE, USING (user_id = auth.uid()), no WITH CHECK
--   "Allow authenticated users to insert notifications" — INSERT, WITH CHECK true (loose)
--
-- DECISIONS:
--   1. DROP the loose INSERT policy. Notifications are written by the system on
--      behalf of users (meeting events, intro events, opportunity events, cron
--      digests). All production INSERT call sites use createAdminClient()
--      (service-role bypass) as of commit 41d9281. The loose user-context
--      policy is unused by production code and represents a real attack surface:
--      any authenticated user can plant arbitrary notifications — including
--      'admin_message' shaped rows — for any other user.
--
--   2. ADD WITH CHECK to the UPDATE policy. The existing UPDATE policy guards
--      the pre-update row via USING (user_id = auth.uid()) but allows the
--      post-update row to carry a different user_id. Adding WITH CHECK
--      (user_id = auth.uid()) blocks ownership reassignment: a user cannot
--      UPDATE their own notification to set user_id to someone else.
--
-- PREREQUISITE COMMITS:
--   41d9281 — fix(notifications): migrate cross-user inserts to admin client
--             (scheduleMeeting, acceptMeeting, declineMeeting, rescheduleMeeting,
--              adminForceMatch). Without this, dropping the loose INSERT policy
--              would silently break meeting and match notifications.
--   5be62c0 — chore(notifications): delete dead mark-read helpers
--   7af8010 — fix(notifications): add missing types to NotificationType union
--
-- PROBE EVIDENCE (Phase A, 2026-05-11 ~14:55 UTC):
--
--   Anon-key probes (BEFORE apply):
--     GET /rest/v1/notifications?select=...        → [] (own-row SELECT policy)
--     GET /rest/v1/notifications?select=count      → content-range: */0
--     POST /rest/v1/notifications (anon role)      → HTTP 401, "new row violates
--                                                    row-level security policy"
--                                                    (anon does not satisfy the
--                                                    authenticated-role INSERT
--                                                    policy — correct denial)
--
--   Authenticated cross-user INSERT probe (BEFORE apply):
--     POST /rest/v1/notifications with member JWT  → HTTP 201
--     Row id: 630966f5-1f52-4b4a-8c7c-866157e20d73
--     Type planted: 'admin_message'
--     The probe demonstrated the policy gap: the loose WITH CHECK true allowed
--     a user-context INSERT with an arbitrary type and a user_id field set by
--     the caller. The probe row was self-targeted (user_id = the probing user's
--     own UUID) to constrain blast radius to a single user's bell.
--
--   The probe row will be deleted in Phase D3 after this migration applies:
--     DELETE FROM public.notifications
--      WHERE id = '630966f5-1f52-4b4a-8c7c-866157e20d73';
--
-- EXPECTED POST-APPLY PROBE RESULTS (Phase D):
--
--   Anon-key probes: unchanged ([] and content-range: */0; SELECT policy not touched).
--
--   Authenticated cross-user INSERT probe: HTTP 4xx (RLS denial). No INSERT
--   policy will permit user-context writes. Service-role (admin client) bypass
--   continues to function via createAdminClient() for all legitimate write
--   paths (cron digests, meeting/intro/opportunity events, etc).
--
-- ROLLBACK PROCEDURE (NOT RECOMMENDED — production code assumes service-role inserts):
--   CREATE POLICY "Allow authenticated users to insert notifications"
--     ON public.notifications FOR INSERT WITH CHECK (true);
--   DROP POLICY "Users can update own notifications"
--     ON public.notifications;
--   CREATE POLICY "Users can update own notifications"
--     ON public.notifications FOR UPDATE USING (user_id = auth.uid());
--   The drop-and-recreate ordering matters: do not run rollback without
--   coordinating with the application team.

-- 1. Drop the loose INSERT policy
DROP POLICY "Allow authenticated users to insert notifications"
  ON public.notifications;

-- 2. Tighten the UPDATE policy by adding WITH CHECK.
--    Drop-and-recreate (PostgreSQL has no ALTER POLICY ... ADD WITH CHECK).
DROP POLICY "Users can update own notifications"
  ON public.notifications;

CREATE POLICY "Users can update own notifications"
  ON public.notifications
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Post-apply verification queries (operator-run):
-- SELECT polname, polcmd,
--        pg_get_expr(polqual, polrelid)      AS using_expr,
--        pg_get_expr(polwithcheck, polrelid) AS with_check_expr
-- FROM pg_policy
-- WHERE polrelid = 'public.notifications'::regclass
-- ORDER BY polcmd, polname;
-- Expected: exactly 2 rows:
--   "Users can view own notifications"   (r) user_id = auth.uid(), null
--   "Users can update own notifications" (w) user_id = auth.uid(), user_id = auth.uid()
