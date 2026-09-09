/**
 * Member community identity — the TypeScript half of the Andrel Next Professional/Next boundary.
 *
 * ─── WHAT THIS IS FOR ─────────────────────────────────────────────────────────────────────────
 * So that Phase 3's matching, pool-scoping and relationship-creation code can reason about
 * "professional" and "next" without scattering raw string literals across a dozen files. A literal
 * repeated at twelve call sites is twelve places to typo it, and a typo'd comparison against
 * `'professsional'` fails OPEN — it makes two members look like different communities in one place
 * and the same community in another.
 *
 * ─── WHAT THIS IS NOT ─────────────────────────────────────────────────────────────────────────
 * NOT a security boundary. Nothing here reads the database, and nothing here is authoritative.
 * public.community_pair_allowed(uuid, uuid) (migration 095) is the authority; these helpers are for
 * code that has ALREADY loaded both members' profiles through an authorized server-side read and
 * needs to reason about them in memory.
 *
 * Where a decision gates the creation of a relationship row, Phase 3 must go through the database
 * predicate — evaluated in the same transaction as the write wherever the write is transactional —
 * rather than trusting an in-memory check that a later refactor could drop. `sameCommunity()` below
 * is for candidate-pool filtering and diagnostics, which is defence in depth, not the gate itself.
 */

/** The two communities. Mirrors the profiles_member_type_check CHECK constraint in migration 095. */
export const MEMBER_TYPES = ['professional', 'next'] as const

export type MemberType = (typeof MEMBER_TYPES)[number]

/** The community every pre-existing member belongs to, and the column's DEFAULT. */
export const DEFAULT_MEMBER_TYPE: MemberType = 'professional'

/** The minimum shape a row needs for any helper here. Deliberately structural, not a profile type. */
export interface HasMemberType {
  member_type?: string | null
}

/**
 * Narrow an arbitrary value to a MemberType.
 *
 * The CHECK constraint means a well-formed row always satisfies this; the guard exists for values
 * arriving from somewhere the constraint does not cover — a request body, a fixture, a `select` that
 * omitted the column and yields `undefined`.
 */
export function isMemberType(value: unknown): value is MemberType {
  return typeof value === 'string' && (MEMBER_TYPES as readonly string[]).includes(value)
}

/**
 * The community of a loaded profile row, or `null` when it cannot be determined.
 *
 * RETURNS NULL RATHER THAN DEFAULTING. Coercing an unknown value to 'professional' would be the
 * dangerous direction: a row whose member_type failed to load would be treated as a professional and
 * could then be paired with real professionals. Callers must handle null as "unknown, therefore not
 * allowed", which is what `sameCommunity` does.
 */
export function communityOf(profile: HasMemberType | null | undefined): MemberType | null {
  const raw = profile?.member_type
  return isMemberType(raw) ? raw : null
}

/** True when a loaded profile is an Andrel Next member. Unknown/absent -> false. */
export function isNextMember(profile: HasMemberType | null | undefined): boolean {
  return communityOf(profile) === 'next'
}

/** True when a loaded profile is a Professional member. Unknown/absent -> false. */
export function isProfessionalMember(profile: HasMemberType | null | undefined): boolean {
  return communityOf(profile) === 'professional'
}

/**
 * The IN-MEMORY mirror of public.community_pair_allowed's base rule: two loaded profiles share a
 * community.
 *
 * Fails closed on every uncertainty — either profile missing, either member_type absent or
 * unrecognised. Deliberately has NO mentorship exception, for the same reason the SQL function does
 * not: the default boundary and its future exception must not share a code path, or a bug in the
 * exception silently widens the default.
 *
 * This is NOT the authority. See the module header.
 */
export function sameCommunity(
  a: HasMemberType | null | undefined,
  b: HasMemberType | null | undefined,
): boolean {
  const ca = communityOf(a)
  const cb = communityOf(b)
  if (ca === null || cb === null) return false
  return ca === cb
}

/**
 * Columns a query must select for the helpers above to work.
 *
 * Phase 3 appends this to the candidate-pool selects so a pool query cannot forget the column and
 * silently produce rows for which `communityOf` returns null.
 */
export const MEMBER_TYPE_COLUMNS = 'member_type'

/**
 * ─── CANDIDATE-POOL SCOPING (Phase 3 Stage 2A) ────────────────────────────────────────────────
 *
 * Keep every candidate in `candidates` that shares `viewer`'s community, in the SAME ORDER.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE STAGE 1 GATES. Stage 1 made the database refuse to WRITE a
 * cross-community relationship, and that remains the authority. It does not stop a cross-community
 * profile from entering a candidate pool first, and entering is not harmless:
 *
 *   • it consumes a top-N slot that an eligible same-community member should have had;
 *   • it consumes one of the reciprocal walker's 8 RPC calls, only to come back 'ineligible';
 *   • it can be the single candidate an opportunity's near-threshold fallback delivers;
 *   • on the Concierge surface its NAME and COMPANY are shown to an admin before any write is
 *     attempted at all.
 *
 * So this runs at pool construction, above ranking, truncation and every fallback — not as a
 * second opinion about what the database will accept.
 *
 * ORDER IS PRESERVED EXACTLY. Callers rank, truncate and tie-break on the array that comes back,
 * so a filter that reordered would change Professional↔Professional results even when it removed
 * nothing. `Array.prototype.filter` is stable by definition; the tests pin it anyway.
 *
 * FAIL CLOSED, ON BOTH SIDES. An unknown, absent or misspelled member_type — on the viewer OR a
 * candidate — excludes. A viewer whose own community cannot be determined gets an EMPTY pool
 * rather than an unscoped one: no introductions is a visible, recoverable outcome; introductions
 * drawn from the wrong community is not.
 *
 * NOT THE SECURITY AUTHORITY. See the module header. It delegates to sameCommunity() so there is
 * exactly one definition of the rule in TypeScript, and it has no mentorship exception for the
 * same reason the SQL predicate has none: the Andrel Next bridge will be its own explicit
 * candidate source, unioned in ABOVE this filter, never a loosening of it.
 */
export function filterSameCommunity<T>(
  viewer: HasMemberType | null | undefined,
  candidates: readonly T[] | null | undefined,
): T[] {
  // T IS UNCONSTRAINED ON PURPOSE, and this is the same compromise applyMemberEligibility already
  // makes ("the internal `any` avoids Supabase's deep-generic instantiation blowups"). Constraining
  // it to HasMemberType collapses a PostgREST row type — which the generated types model as
  // GenericStringError until it is cast — down to HasMemberType, and every downstream `.id` /
  // `.expertise` access in the caller then fails to compile. The row shape is preserved instead, so
  // callers keep the exact typing they had before this filter existed.
  //
  // What guarantees member_type is actually THERE is not this signature: it is the select list, and
  // a structural test asserts every scoped pool names the column. If a caller ever forgets it,
  // communityOf returns null for every row and the pool comes back EMPTY — visibly broken, which is
  // the correct direction to fail.
  if (communityOf(viewer) === null) return []
  return (candidates ?? []).filter((c) => sameCommunity(viewer, c as HasMemberType))
}

/**
 * ─── COHORT PARTITIONING (Phase 3 Stage 2B) ───────────────────────────────────────────────────
 *
 * Split a cohort into one array per community, preserving input order exactly within each.
 *
 * WHY THIS IS NOT filterSameCommunity. The six Stage 2A pools are viewer-relative: one requester,
 * many candidates, so scoping is a filter. The Admin/Thursday batch has NO viewer — it builds one
 * cohort of every eligible member and runs a global b-matching over all pairs. There is nobody to
 * filter "against".
 *
 * WHY IT MUST HAPPEN BEFORE SCORING, NOT AFTER. Removing cross-community EDGES after scoring is
 * not sufficient, and the reason is arithmetic rather than stylistic. Two separate channels let one
 * community change the other's results even when no cross-community pair survives:
 *
 *   1. buildScoringContext derives memberCount from the cohort, and idfWeight is
 *      log((N+1)/(df+1)) / log(N+1). N is the cohort size, so every Professional↔Professional
 *      score depends on how many Next members happen to exist.
 *   2. solveGlobalBMatching's reduceComponent keeps each member's top-k edges and HALVES k until
 *      the component fits MAX_COMPONENT_EDGES. A mixed cohort forms one larger connected component,
 *      so Professionals would get a more aggressive edge reduction than they do today — degraded
 *      match quality with no cross-community pair anywhere in the output.
 *
 * Partitioning first removes both channels at once: each community builds its own context and
 * solves its own graph, and there is no variable in scope holding the combined cohort.
 *
 * ORDER IS PRESERVED EXACTLY, and this is load-bearing rather than tidy. The batch generator builds
 * pairs with a nested `for i < j` loop over the cohort array and then sorts with a comparator that
 * returns 0 for pairs within a ±10 relevance band and equal mutual score. Ties therefore fall
 * through to Array.prototype.sort's stability — that is, to this array's order. A partition that
 * reordered would change which Professional pairs win ties, on a database with no Next members at
 * all. With one community present the Professional partition is the input array element for
 * element, so every downstream stage sees exactly what it sees today.
 *
 * FAILS CLOSED. A row whose member_type is absent, null or unrecognised enters NEITHER partition.
 * It contributes to no scoring context, no memberCount, no capacity and no suggestion. Callers
 * report the count of such rows as an aggregate diagnostic; they never default it to professional.
 *
 * NO EXCEPTIONS LIVE HERE. Not mentorship, not recruiting/hiring. Those bridges will be explicit
 * cross-community candidate SOURCES layered above the ordinary rule, never a loosening of it — the
 * ordinary Thursday batch stays same-community permanently.
 */
export function partitionByCommunity<T>(
  rows: readonly T[] | null | undefined,
): Map<MemberType, T[]> {
  // Every community is present as a key, even when empty, so a caller can iterate MEMBER_TYPES
  // without branching on absence — and so a community with too few members is a natural no-op
  // rather than a missing entry someone has to remember to handle.
  const out = new Map<MemberType, T[]>(MEMBER_TYPES.map((t) => [t, [] as T[]]))
  for (const row of rows ?? []) {
    // communityOf returns null rather than guessing, so unknown/malformed simply matches no bucket.
    const community = communityOf(row as HasMemberType)
    if (community === null) continue
    out.get(community)!.push(row)
  }
  return out
}

/** Rows that entered NO partition: absent, null or unrecognised member_type. Never defaulted. */
export function countUnknownCommunity(rows: readonly unknown[] | null | undefined): number {
  return (rows ?? []).filter((r) => communityOf(r as HasMemberType) === null).length
}
