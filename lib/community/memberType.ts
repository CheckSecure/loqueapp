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
