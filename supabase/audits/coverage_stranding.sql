-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- READ-ONLY: who is stranded with an EMPTY Introductions page right now?
--
-- WHY THIS MATTERS AFTER WEEKLY_COVERAGE_GENERATION=off. A 'queued' card becomes visible only
-- via public.promote_queued_rows, which is called ONLY from the member's OWN actions
-- (express-interest, accept-incoming, createIntroRequest, app/actions.ts). There is no cron.
-- So a member with ZERO visible cards has nothing to act on, nothing calls promotion, and their
-- queued cards stay hidden — permanently.
--
-- Coverage generation used to break that cycle: it filled members holding no visible card, which
-- gave them something to act on, which triggered promotion. With coverage off, nothing does.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
WITH eligible AS (
  SELECT p.id, p.full_name, p.email FROM public.profiles p
  WHERE p.account_status = 'active' AND p.profile_complete IS TRUE
    AND p.is_test_account IS DISTINCT FROM TRUE AND p.is_admin IS DISTINCT FROM TRUE
    AND p.matching_paused IS DISTINCT FROM TRUE
    AND coalesce(p.email,'') <> 'bizdev91@gmail.com'
),
s AS (
  SELECT e.id, e.full_name, e.email,
    (SELECT count(*) FROM public.intro_requests ir
      WHERE ir.requester_id = e.id AND ir.status = 'suggested')        AS visible_cards,
    (SELECT count(*) FROM public.intro_requests ir
      WHERE ir.requester_id = e.id AND ir.status = 'queued')           AS queued_cards,
    (SELECT count(*) FROM public.recommendation_batches rb
      WHERE rb.member_id = e.id AND rb.state = 'queued')               AS queued_batches,
    (SELECT count(*) FROM public.recommendation_batches rb
      WHERE rb.member_id = e.id AND rb.state = 'active')               AS active_batches
  FROM eligible e
)
-- A. The headline: how many members see an empty page, and how many of those are sitting on
--    cards that exist but will never be revealed without an action they have no reason to take.
SELECT 'A. stranding summary' AS section,
       count(*)                                                            AS eligible_members,
       count(*) FILTER (WHERE visible_cards = 0)                           AS empty_screen,
       count(*) FILTER (WHERE visible_cards = 0 AND queued_cards > 0)      AS empty_AND_holding_queued,
       count(*) FILTER (WHERE visible_cards = 0 AND queued_batches > 0)    AS empty_AND_queued_batch,
       sum(queued_cards) FILTER (WHERE visible_cards = 0)                  AS hidden_cards_total
FROM s;

-- B. The stranded members themselves, worst first. Every row here is a member who cannot reach
--    their own cards: DEADLOCKED means the cards exist and nothing will ever show them.
WITH eligible AS (
  SELECT p.id, p.full_name, p.email FROM public.profiles p
  WHERE p.account_status = 'active' AND p.profile_complete IS TRUE
    AND p.is_test_account IS DISTINCT FROM TRUE AND p.is_admin IS DISTINCT FROM TRUE
    AND p.matching_paused IS DISTINCT FROM TRUE
    AND coalesce(p.email,'') <> 'bizdev91@gmail.com'
), s AS (
  SELECT e.id, e.full_name, e.email,
    (SELECT count(*) FROM public.intro_requests ir
      WHERE ir.requester_id = e.id AND ir.status = 'suggested')  AS visible_cards,
    (SELECT count(*) FROM public.intro_requests ir
      WHERE ir.requester_id = e.id AND ir.status = 'queued')     AS queued_cards,
    (SELECT count(*) FROM public.recommendation_batches rb
      WHERE rb.member_id = e.id AND rb.state = 'queued')         AS queued_batches,
    (SELECT count(*) FROM public.recommendation_batches rb
      WHERE rb.member_id = e.id AND rb.state = 'active')         AS active_batches
  FROM eligible e
)
SELECT 'B. stranded members' AS section, full_name, email,
       visible_cards, queued_cards, queued_batches, active_batches,
       CASE
         WHEN queued_cards > 0 AND queued_batches > 0
           THEN 'DEADLOCKED — holds ' || queued_cards || ' hidden card(s); only their own action promotes, and they have none to take'
         WHEN queued_cards > 0
           THEN 'HIDDEN CARDS, NO QUEUED BATCH — promote_queued_rows cannot reach them at all'
         ELSE 'EMPTY — no cards at all; needs generation, not promotion'
       END AS state
FROM s
WHERE visible_cards = 0
ORDER BY queued_cards DESC, full_name;
