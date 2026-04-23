// Bidirectional filter helpers for Supabase/PostgREST .or() queries.
// Centralized to prevent subtle syntax bugs that cause silent empty-result failures.

/**
 * Build a PostgREST .or() filter that matches a match row regardless of direction.
 * i.e. (user_a_id = A AND user_b_id = B) OR (user_a_id = B AND user_b_id = A)
 *
 * Correct PostgREST syntax is `and(a.eq.X,b.eq.Y),and(a.eq.Y,b.eq.X)` with
 * NO outer parens around each and(...) clause. Parens cause silent miss.
 */
export function buildBidirectionalMatchFilter(userA: string, userB: string): string {
  return 'and(user_a_id.eq.' + userA + ',user_b_id.eq.' + userB + '),and(user_a_id.eq.' + userB + ',user_b_id.eq.' + userA + ')'
}

/**
 * Build a PostgREST .or() filter for a blocked_users row where either direction of block applies.
 */
export function buildBidirectionalBlockFilter(userA: string, userB: string): string {
  return 'and(user_id.eq.' + userA + ',blocked_user_id.eq.' + userB + '),and(user_id.eq.' + userB + ',blocked_user_id.eq.' + userA + ')'
}

/**
 * Build a PostgREST .or() filter for intro_requests in either direction between two users.
 */
export function buildBidirectionalIntroRequestFilter(userA: string, userB: string): string {
  return 'and(requester_id.eq.' + userA + ',target_user_id.eq.' + userB + '),and(requester_id.eq.' + userB + ',target_user_id.eq.' + userA + ')'
}
