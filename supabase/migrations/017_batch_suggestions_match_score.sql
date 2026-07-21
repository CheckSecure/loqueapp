-- Widen batch_suggestions.match_score so real match scores fit.
--
-- Root cause of "numeric field overflow" on Generate New Batch: match_score was
-- numeric(4,2) (max 99.99), but the scoring heuristic (scoreMatch) is an
-- unbounded additive sum — boost alone is boost_score*2 (up to 200), plus
-- unbounded purpose/interest overlaps — so scores routinely exceed 100 and can
-- reach several hundred. Any score >= 100 failed to insert.
--
-- numeric(6,2) holds ±9999.99, comfortably above the realistic max (~600) with
-- headroom, keeps the 2-decimal scale, and is a WIDENING type change: it
-- preserves every existing value and never rewrites the table. batch_suggestions
-- is currently empty in production, so this is a no-op on existing data.
--
-- Backward-compatible: the currently-deployed code already writes these values
-- (it was only failing on the narrow column), so this migration is safe to apply
-- BEFORE the code deploy and unblocks batch generation immediately.

ALTER TABLE batch_suggestions
  ALTER COLUMN match_score TYPE numeric(6,2);
