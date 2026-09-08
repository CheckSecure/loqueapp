# Exact anchor -> replacement. Each MUST occur exactly once in its function body.
GUARDS = {
"create_reciprocal_suggestion": [(
"""  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));
""",
"""  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  -- (0b) COMMUNITY BOUNDARY (migration 096). Evaluated under BOTH advisory locks and in the same
  -- transaction as the insert below, so member_type cannot change between the check and the write.
  -- 'ineligible' is deliberate: walkCandidates already treats it as a DETERMINISTIC skip that is
  -- never retried, so no TypeScript caller changes for this guard.
  IF NOT public.community_pair_allowed(lo, hi) THEN
    RETURN 'ineligible';
  END IF;
""")],

"materialize_admin_pair": [(
"""  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));
""",
"""  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  -- COMMUNITY BOUNDARY (migration 096). Under both locks, before any batch_suggestions read or
  -- intro_requests write. Reuses the function's existing 'ineligible' outcome shape, so the
  -- approve-batch caller's outcome handling is unchanged.
  IF NOT public.community_pair_allowed(lo, hi) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','ineligible','detail','cross_community');
  END IF;
""")],

"finalize_mutual_match_atomic": [(
"""  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));
""",
"""  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lo::text, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(hi::text, 0));

  -- COMMUNITY BOUNDARY (migration 096) — FIRST of two layers, and the one that actually fires.
  -- It must refuse BEFORE delegating: the delegate signals failure through error_code, and
  -- lib/introductions/finalizeMutualMatch.ts only recognises insufficient_credits_a/_b and
  -- duplicate_match, so an unrecognised code would fall through to an undefined match_id. The
  -- existing 'invalid' outcome is already handled by every caller as a 409, so no Stage 1b
  -- TypeScript change is required for this guard.
  IF NOT public.community_pair_allowed(p_user_a, p_user_b) THEN
    RETURN pg_catalog.jsonb_build_object('outcome','invalid','detail','cross_community');
  END IF;
""")],

"consume_credits_and_create_match": [(
"""    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        LEAST(p_user_a, p_user_b)::text || ':' || GREATEST(p_user_a, p_user_b)::text, 0));
""",
"""    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        LEAST(p_user_a, p_user_b)::text || ':' || GREATEST(p_user_a, p_user_b)::text, 0));

    -- COMMUNITY BOUNDARY (migration 096) — SECOND, SEALED layer. Normally unreachable for a
    -- cross-community request because finalize_mutual_match_atomic refuses first, and migration 068
    -- revoked EXECUTE on this function from PUBLIC, anon, authenticated AND service_role, leaving
    -- the definer wrapper as the only caller. It exists so the LOWEST writer of a matches row is
    -- itself authoritative rather than trusting its one caller.
    IF NOT public.community_pair_allowed(p_user_a, p_user_b) THEN
      RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'cross_community'::text;
      RETURN;
    END IF;
""")],

"place_batch_rows": [(
"""        AND p.email <> 'bizdev91@gmail.com'
    )
    -- not blocked in either direction
""",
"""        AND p.email <> 'bizdev91@gmail.com'
    )
    -- COMMUNITY BOUNDARY (migration 096). A SET-WISE filter, in the same candidate chain as the
    -- blocked/matched/cooldown exclusions below, so a cross-community counterpart simply drops out
    -- of v_candidates and the member's remaining valid candidates in the SAME call proceed
    -- normally. Rejecting the whole placement because one candidate is cross-community would cost
    -- a member their entire cycle's introductions for a condition the Stage 2 pool scoping will
    -- prevent from arising at all.
    AND public.community_pair_allowed(p_member_id, d.target_user_id)
    -- not blocked in either direction
""")],

"promote_queued_rows": [(
"""    SELECT ir.id FROM public.intro_requests ir
    WHERE ir.requester_id = p_member_id AND ir.batch_id = v_queued.batch_id AND ir.status = 'queued'
    ORDER BY ir.created_at, ir.id
""",
"""    SELECT ir.id FROM public.intro_requests ir
    WHERE ir.requester_id = p_member_id AND ir.batch_id = v_queued.batch_id AND ir.status = 'queued'
      -- COMMUNITY BOUNDARY (migration 096). 'queued' is OUTSIDE the discovery grant set and
      -- 'suggested' is INSIDE it, so this UPDATE is itself a discovery transition. Filtering here
      -- means a stale cross-community reservation can never become discoverable, while the
      -- member's valid queued rows in the same call still promote. The stale row is left as-is:
      -- preventing the transition is the requirement; deleting it is not.
      AND public.community_pair_allowed(p_member_id, ir.target_user_id)
    ORDER BY ir.created_at, ir.id
""")],
}
