/**
 * Match-score bounds + validation for batch_suggestions.match_score.
 *
 * The scoring heuristic (scoreMatch in the batch routes) is an UNBOUNDED additive
 * sum — boost alone contributes up to 200, plus unbounded purpose/interest
 * overlaps — so real scores routinely exceed 100 and can reach several hundred.
 * The column was originally numeric(4,2) (max 99.99), which overflowed. Migration
 * 017 widens it to numeric(6,2) (±9999.99). These helpers keep values inside that
 * capacity and turn an out-of-range/NaN value into a descriptive error at the
 * source, instead of a cryptic "numeric field overflow" from Postgres.
 */

/** Storable range — matches the numeric(6,2) column (migration 017). */
export const MATCH_SCORE_MAX = 9999.99
export const MATCH_SCORE_MIN = -9999.99

/**
 * Coerce a raw score into a finite, DB-storable integer. Scores are conceptually
 * integers (all terms are integer additions), so we round; NaN/Infinity (e.g. a
 * divide-by-zero in an upstream sub-score) collapse to 0 rather than corrupting
 * the insert.
 */
export function sanitizeMatchScore(raw: number): number {
  const n = Math.round(raw)
  return Number.isFinite(n) ? n : 0
}

/**
 * Throw a descriptive error if a score cannot be stored. Defense-in-depth run
 * immediately before insert so a scoring bug fails loudly with the member and
 * candidate, not with an opaque database overflow.
 */
export function assertStorableScore(score: number, recipientId: string, suggestedId: string): void {
  if (!Number.isFinite(score) || score > MATCH_SCORE_MAX || score < MATCH_SCORE_MIN) {
    throw new Error(
      `Invalid suggestion score for member ${recipientId} and candidate ${suggestedId}: ` +
      `received ${score}; expected ${MATCH_SCORE_MIN}–${MATCH_SCORE_MAX}`,
    )
  }
}
