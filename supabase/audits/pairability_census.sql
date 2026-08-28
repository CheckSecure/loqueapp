-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- READ-ONLY: how many members can ACTUALLY pair with each member right now?
--
-- Applies the gates create_reciprocal_suggestion applies, in its order (085 / 063):
--   (a) both eligible                                   -> 'ineligible'
--   (b) not the same company
--   (c) no existing row for the pair, incl. the 30-day cooldown on passed/expired -> 'exists_active'
--   (d) NEITHER side holds an unresolved 'suggested' card                         -> 'unresolved'
--   (e) both under the 2-card visible cap                                         -> 'capacity'
--
-- (d) is the one this thread was chasing. "Unresolved" = a 'suggested' row whose requester has
-- not expressed interest, the target is active, and no match exists — i.e. the member OWES A
-- RESPONSE. It blocks the pair from EITHER side, so one member's inaction removes them from
-- every other member's pool.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
WITH e AS (
  SELECT p.id, p.full_name, p.email, p.company FROM public.profiles p
  WHERE p.account_status='active' AND p.profile_complete IS TRUE
    AND p.is_test_account IS DISTINCT FROM TRUE AND p.is_admin IS DISTINCT FROM TRUE
    AND p.matching_paused IS DISTINCT FROM TRUE
    AND coalesce(p.email,'') <> 'bizdev91@gmail.com'
),
-- (d) mirrors public.count_unresolved_introductions
owes AS (
  SELECT DISTINCT s.requester_id AS id
  FROM public.intro_requests s
  JOIN public.profiles t ON t.id = s.target_user_id
  WHERE s.status = 'suggested'
    AND t.account_status = 'active'
    AND NOT EXISTS (SELECT 1 FROM public.intro_requests x
                     WHERE x.requester_id = s.requester_id AND x.target_user_id = s.target_user_id
                       AND x.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending'))
    AND NOT EXISTS (SELECT 1 FROM public.intro_requests inb
                     WHERE inb.requester_id = s.target_user_id AND inb.target_user_id = s.requester_id
                       AND inb.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending'))
    AND NOT EXISTS (SELECT 1 FROM public.matches m
                     WHERE (m.user_a_id = s.requester_id AND m.user_b_id = s.target_user_id)
                        OR (m.user_b_id = s.requester_id AND m.user_a_id = s.target_user_id))
),
cards AS (
  SELECT e.id, (SELECT count(*) FROM public.intro_requests ir
                 WHERE ir.requester_id = e.id AND ir.status='suggested') AS visible
  FROM e
),
pairable AS (
  SELECT a.id, a.full_name, a.email,
         (a.id IN (SELECT id FROM owes))                                     AS a_owes,
         count(b.id) FILTER (
           WHERE b.id <> a.id
             AND (a.company IS DISTINCT FROM b.company OR a.company IS NULL OR b.company IS NULL)
             AND b.id NOT IN (SELECT id FROM owes)
             AND (SELECT visible FROM cards WHERE cards.id = b.id) < 2
             AND NOT EXISTS (
               SELECT 1 FROM public.intro_requests ir
               WHERE ((ir.requester_id = a.id AND ir.target_user_id = b.id)
                   OR (ir.requester_id = b.id AND ir.target_user_id = a.id))
                 AND (ir.status IN ('suggested','queued','pending','accepted','accepted_pending_payment',
                                    'admin_pending','approved','declined','rejected','hidden','hidden_permanent')
                   OR (ir.status IN ('passed','expired') AND ir.updated_at >= now() - interval '30 days')))
         )                                                                    AS partners_now
  FROM e a CROSS JOIN e b
  GROUP BY a.id, a.full_name, a.email, a.company
)
SELECT 'A. pairability' AS section,
       count(*)                                        AS eligible_members,
       count(*) FILTER (WHERE a_owes)                  AS members_who_owe_a_response,
       count(*) FILTER (WHERE partners_now = 0)        AS members_with_ZERO_partners,
       count(*) FILTER (WHERE partners_now BETWEEN 1 AND 4) AS members_with_1_to_4,
       round(avg(partners_now), 1)                     AS avg_partners,
       max(partners_now)                               AS max_partners
FROM pairable;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- READ-ONLY: how many members can ACTUALLY pair with each member right now?
--
-- Applies the gates create_reciprocal_suggestion applies, in its order (085 / 063):
--   (a) both eligible                                   -> 'ineligible'
--   (b) not the same company
--   (c) no existing row for the pair, incl. the 30-day cooldown on passed/expired -> 'exists_active'
--   (d) NEITHER side holds an unresolved 'suggested' card                         -> 'unresolved'
--   (e) both under the 2-card visible cap                                         -> 'capacity'
--
-- (d) is the one this thread was chasing. "Unresolved" = a 'suggested' row whose requester has
-- not expressed interest, the target is active, and no match exists — i.e. the member OWES A
-- RESPONSE. It blocks the pair from EITHER side, so one member's inaction removes them from
-- every other member's pool.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
WITH e AS (
  SELECT p.id, p.full_name, p.email, p.company FROM public.profiles p
  WHERE p.account_status='active' AND p.profile_complete IS TRUE
    AND p.is_test_account IS DISTINCT FROM TRUE AND p.is_admin IS DISTINCT FROM TRUE
    AND p.matching_paused IS DISTINCT FROM TRUE
    AND coalesce(p.email,'') <> 'bizdev91@gmail.com'
),
-- (d) mirrors public.count_unresolved_introductions
owes AS (
  SELECT DISTINCT s.requester_id AS id
  FROM public.intro_requests s
  JOIN public.profiles t ON t.id = s.target_user_id
  WHERE s.status = 'suggested'
    AND t.account_status = 'active'
    AND NOT EXISTS (SELECT 1 FROM public.intro_requests x
                     WHERE x.requester_id = s.requester_id AND x.target_user_id = s.target_user_id
                       AND x.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending'))
    AND NOT EXISTS (SELECT 1 FROM public.intro_requests inb
                     WHERE inb.requester_id = s.target_user_id AND inb.target_user_id = s.requester_id
                       AND inb.status IN ('pending','approved','accepted','accepted_pending_payment','admin_pending'))
    AND NOT EXISTS (SELECT 1 FROM public.matches m
                     WHERE (m.user_a_id = s.requester_id AND m.user_b_id = s.target_user_id)
                        OR (m.user_b_id = s.requester_id AND m.user_a_id = s.target_user_id))
),
cards AS (
  SELECT e.id, (SELECT count(*) FROM public.intro_requests ir
                 WHERE ir.requester_id = e.id AND ir.status='suggested') AS visible
  FROM e
),
pairable AS (
  SELECT a.id, a.full_name, a.email,
         (a.id IN (SELECT id FROM owes))                                     AS a_owes,
         count(b.id) FILTER (
           WHERE b.id <> a.id
             AND (a.company IS DISTINCT FROM b.company OR a.company IS NULL OR b.company IS NULL)
             AND b.id NOT IN (SELECT id FROM owes)
             AND (SELECT visible FROM cards WHERE cards.id = b.id) < 2
             AND NOT EXISTS (
               SELECT 1 FROM public.intro_requests ir
               WHERE ((ir.requester_id = a.id AND ir.target_user_id = b.id)
                   OR (ir.requester_id = b.id AND ir.target_user_id = a.id))
                 AND (ir.status IN ('suggested','queued','pending','accepted','accepted_pending_payment',
                                    'admin_pending','approved','declined','rejected','hidden','hidden_permanent')
                   OR (ir.status IN ('passed','expired') AND ir.updated_at >= now() - interval '30 days')))
         )                                                                    AS partners_now
  FROM e a CROSS JOIN e b
  GROUP BY a.id, a.full_name, a.email, a.company
)
SELECT 'B. per member' AS section, full_name, email,
       a_owes                                          AS owes_a_response,
       partners_now                                    AS can_pair_with_now,
       CASE WHEN partners_now = 0 THEN 'STUCK — no viable counterpart'
            WHEN partners_now < 2 THEN 'cannot reach 2 introductions'
            ELSE 'ok' END                              AS state
FROM pairable
ORDER BY partners_now, full_name;
