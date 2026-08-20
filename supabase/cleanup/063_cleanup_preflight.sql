-- 063_cleanup_preflight.sql
--
-- ██ READ-ONLY. Run in the Supabase SQL Editor. Makes no changes. ██
--
-- PURPOSE. The cleanup script must operate on an EXACT, IMMUTABLE set of row ids captured from
-- production, not on "whichever four members happen to be over capacity when it runs". This query
-- captures that manifest. Its output is transcribed verbatim into the cleanup's expected-target
-- block, after which the cleanup will refuse to touch anything else — including a different set of
-- four members that merely happens to have the same shape.
--
-- WHAT IT RETURNS. One row, one jsonb column named `preflight`. Click the cell and copy it whole.
--
-- PRIVACY. Row and member UUIDs only — the manifest cannot be built without them. NO email, name,
-- title, company, match_reason text or any other profile content is selected. Statuses, timestamps
-- and structural relationships are included because the cleanup's guards check them.
--
-- SAFETY. SELECT only. No DDL, no DML, no function calls with side effects. Every reference is
-- schema-qualified.

WITH over AS (
  -- The population, discovered ONCE, here. The cleanup will not repeat this discovery.
  SELECT ir.requester_id AS member_id
  FROM public.intro_requests ir
  WHERE ir.status = 'suggested'
  GROUP BY ir.requester_id
  HAVING count(*) > 2
),

-- ── the reciprocal card each affected member holds (batch_id NULL, pair_id set) ─────────────────
recip AS (
  SELECT ir.requester_id AS member_id,
         ir.id           AS recip_intro_id,
         ir.pair_id,
         ir.target_user_id AS counterpart_id,
         ir.status, ir.created_at, ir.updated_at,
         ir.batch_id
  FROM public.intro_requests ir
  JOIN over o ON o.member_id = ir.requester_id
  WHERE ir.status = 'suggested' AND ir.pair_id IS NOT NULL
),

-- ── the visible admin-batch cards, ranked by the DETERMINISTIC demotion rule ────────────────────
-- rank 1 = the card the cleanup would demote (latest created_at, ties by higher id).
admin_cards AS (
  SELECT ir.requester_id AS member_id,
         ir.id, ir.target_user_id, ir.batch_id, ir.status,
         ir.created_at, ir.updated_at,
         row_number() OVER (PARTITION BY ir.requester_id
                            ORDER BY ir.created_at DESC, ir.id DESC) AS demote_rank
  FROM public.intro_requests ir
  JOIN over o ON o.member_id = ir.requester_id
  WHERE ir.status = 'suggested' AND ir.batch_id IS NOT NULL
),

-- ── the active batch each affected member holds ─────────────────────────────────────────────────
act AS (
  SELECT b.member_id, b.batch_id, b.batch_source, b.state, b.reciprocal_batch_id,
         b.created_at, b.generated_at, b.displayed_at, b.completed_at
  FROM public.recommendation_batches b
  JOIN over o ON o.member_id = b.member_id
  WHERE b.state = 'active'
),

-- ── per-member counts and interest state ────────────────────────────────────────────────────────
counts AS (
  SELECT o.member_id,
         (SELECT count(*) FROM public.intro_requests x
           WHERE x.requester_id = o.member_id AND x.status = 'suggested')                AS visible,
         (SELECT count(*) FROM public.intro_requests x
           WHERE x.requester_id = o.member_id AND x.status = 'queued')                   AS reserved,
         (SELECT count(*) FROM public.intro_requests x
           WHERE x.requester_id = o.member_id AND x.status='suggested' AND x.pair_id IS NOT NULL)  AS reciprocal_cards,
         (SELECT count(*) FROM public.intro_requests x
           WHERE x.requester_id = o.member_id AND x.status='suggested' AND x.batch_id IS NOT NULL) AS admin_cards,
         (SELECT count(*) FROM public.recommendation_batches b
           WHERE b.member_id = o.member_id AND b.state = 'active')                       AS active_batches,
         (SELECT count(*) FROM public.recommendation_batches b
           WHERE b.member_id = o.member_id AND b.state = 'queued')                       AS queued_batches,
         (SELECT count(*) FROM public.intro_requests e
           WHERE e.requester_id = o.member_id
             AND e.status IN ('pending','accepted','accepted_pending_payment','admin_pending','approved')
             AND e.target_user_id IN (SELECT s.target_user_id FROM public.intro_requests s
                                       WHERE s.requester_id = o.member_id AND s.status='suggested'))
                                                                                          AS expressed_interest_on_visible
  FROM over o
),

-- ── the pairs, with BOTH directional intro ids ──────────────────────────────────────────────────
pairs AS (
  SELECT mp.id AS pair_id, mp.user_a_id, mp.user_b_id, mp.source, mp.status,
         mp.recommend_count, mp.created_at, mp.first_recommended_at, mp.last_recommended_at,
         (SELECT ir.id FROM public.intro_requests ir
           WHERE ir.pair_id = mp.id AND ir.requester_id = mp.user_a_id
             AND ir.target_user_id = mp.user_b_id AND ir.status='suggested')  AS intro_a_to_b,
         (SELECT ir.id FROM public.intro_requests ir
           WHERE ir.pair_id = mp.id AND ir.requester_id = mp.user_b_id
             AND ir.target_user_id = mp.user_a_id AND ir.status='suggested')  AS intro_b_to_a,
         (SELECT count(*) FROM public.intro_requests ir
           WHERE ir.pair_id = mp.id AND ir.status='suggested')                AS visible_sides
  FROM public.member_pairs mp
  WHERE mp.id IN (SELECT DISTINCT pair_id FROM recip)
),

-- ── one object per affected member ──────────────────────────────────────────────────────────────
members AS (
  SELECT jsonb_build_object(
    'member_id',        c.member_id,
    'visible',          c.visible,
    'reserved',         c.reserved,
    'reciprocal_cards', c.reciprocal_cards,
    'admin_cards',      c.admin_cards,
    'active_batches',   c.active_batches,
    'queued_batches',   c.queued_batches,
    'expressed_interest_on_visible', c.expressed_interest_on_visible,
    'reciprocal', (SELECT jsonb_build_object(
                     'intro_id',       r.recip_intro_id,
                     'pair_id',        r.pair_id,
                     'counterpart_id', r.counterpart_id,
                     'status',         r.status,
                     'batch_id_is_null', r.batch_id IS NULL,
                     'created_at',     r.created_at,
                     'updated_at',     r.updated_at)
                   FROM recip r WHERE r.member_id = c.member_id),
    'active_batch', (SELECT jsonb_build_object(
                       'batch_id',            a.batch_id,
                       'batch_source',        a.batch_source,
                       'state',               a.state,
                       'reciprocal_batch_id', a.reciprocal_batch_id,
                       'created_at',          a.created_at,
                       'generated_at',        a.generated_at,
                       'displayed_at',        a.displayed_at,
                       'completed_at',        a.completed_at)
                     FROM act a WHERE a.member_id = c.member_id),
    'admin_visible_cards', (SELECT jsonb_agg(jsonb_build_object(
                              'intro_id',       ac.id,
                              'target_user_id', ac.target_user_id,
                              'batch_id',       ac.batch_id,
                              'status',         ac.status,
                              'created_at',     ac.created_at,
                              'updated_at',     ac.updated_at,
                              'demote_rank',    ac.demote_rank) ORDER BY ac.demote_rank)
                            FROM admin_cards ac WHERE ac.member_id = c.member_id),
    -- THE deterministic demotion target: rank 1 under (created_at DESC, id DESC).
    'demote_intro_id', (SELECT ac.id FROM admin_cards ac
                        WHERE ac.member_id = c.member_id AND ac.demote_rank = 1),
    'keep_intro_id',   (SELECT ac.id FROM admin_cards ac
                        WHERE ac.member_id = c.member_id AND ac.demote_rank = 2)
  ) AS j, c.member_id
  FROM counts c
)

SELECT jsonb_build_object(
  'preflight_version', '063.cleanup.1',
  'generated_at',      now(),
  'server_version_num', pg_catalog.current_setting('server_version_num'),
  -- Global shape, so the cleanup can assert the population has not grown or shrunk.
  'global', jsonb_build_object(
    'members_over_visible_cap', (SELECT count(*) FROM over),
    'members_over_reserved_cap', (SELECT count(*) FROM (
        SELECT requester_id FROM public.intro_requests WHERE status='queued'
        GROUP BY 1 HAVING count(*) > 2) z),
    'total_suggested_rows',     (SELECT count(*) FROM public.intro_requests WHERE status='suggested'),
    'total_queued_rows',        (SELECT count(*) FROM public.intro_requests WHERE status='queued'),
    'members_with_multi_active_batch', (SELECT count(*) FROM (
        SELECT member_id FROM public.recommendation_batches WHERE state='active'
        GROUP BY 1 HAVING count(*) > 1) z),
    'members_with_multi_queued_batch', (SELECT count(*) FROM (
        SELECT member_id FROM public.recommendation_batches WHERE state='queued'
        GROUP BY 1 HAVING count(*) > 1) z),
    'batches_with_wrong_status_rows', (SELECT count(*)
        FROM public.recommendation_batches b
        JOIN public.intro_requests i ON i.batch_id = b.batch_id
        WHERE (b.state='active' AND i.status <> 'suggested')
           OR (b.state='queued' AND i.status <> 'queued'))
  ),
  'affected_members', (SELECT coalesce(jsonb_agg(j ORDER BY member_id), '[]'::jsonb) FROM members),
  'pairs', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'pair_id',              p.pair_id,
                'user_a_id',            p.user_a_id,
                'user_b_id',            p.user_b_id,
                'source',               p.source,
                'status',               p.status,
                'recommend_count',      p.recommend_count,
                'created_at',           p.created_at,
                'first_recommended_at', p.first_recommended_at,
                'last_recommended_at',  p.last_recommended_at,
                'intro_a_to_b',         p.intro_a_to_b,
                'intro_b_to_a',         p.intro_b_to_a,
                'visible_sides',        p.visible_sides) ORDER BY p.pair_id), '[]'::jsonb)
            FROM pairs p),
  -- A stable digest of the exact id manifest. The cleanup recomputes it and refuses to run if the
  -- live rows no longer hash to this value, which catches any drift the individual guards miss.
  'manifest_digest', (
    SELECT md5(string_agg(t, '|' ORDER BY t)) FROM (
      SELECT r.member_id::text || ':' || r.recip_intro_id::text || ':' || r.pair_id::text AS t FROM recip r
      UNION ALL
      SELECT ac.member_id::text || ':' || ac.id::text || ':' || ac.demote_rank::text FROM admin_cards ac
      UNION ALL
      SELECT a.member_id::text || ':' || a.batch_id::text FROM act a
    ) s)
) AS preflight;
