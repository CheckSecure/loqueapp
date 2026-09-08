/**
 * The TypeScript community pre-check — defence in depth, NEVER the authority.
 *
 * ─── WHAT THIS IS ─────────────────────────────────────────────────────────────────────────────
 * A server-side, service-role read of both members' member_type, so a relationship-creating flow
 * can refuse a cross-community pair with a real message BEFORE it starts writing, and so a path
 * whose downstream SQL gate is coarse (or, as with createAdminIntroPair, absent) has a reviewed
 * place to fail closed.
 *
 * ─── WHAT THIS IS NOT ─────────────────────────────────────────────────────────────────────────
 * NOT the security boundary. public.community_pair_allowed(uuid, uuid) (migration 095), consulted
 * inside the SQL writers under their advisory locks in the same transaction as the write
 * (migration 096), is the authority. This runs earlier, in a different process, against a snapshot
 * that can be stale by the time the write happens — which is precisely why it may never be the
 * only layer for a path that has an SQL gate available.
 *
 * A check here that AGREES with the database is a better error message. A check here that
 * DISAGREES with the database is a bug in this file, and the database still wins. Never invert
 * that: do not let a caller skip the RPC because this returned `allowed`.
 *
 * ─── FAIL-CLOSED, AND THE ONE DISTINCTION THAT MATTERS ────────────────────────────────────────
 * Every uncertainty denies. But `unavailable` (the read did not answer) is kept separate from
 * `cross_community` / `unknown_member_type` (the read answered and the answer was no), for the
 * same reason lib/profiles/serverProfile.ts keeps `unavailable` separate from `not_found`: a
 * caller must be able to surface "try again" for a transport fault instead of telling a member
 * something false about who they are allowed to meet. Both still refuse the write.
 */

import { readProfilesByIds } from '@/lib/profiles/serverProfile'
import {
  MEMBER_TYPE_COLUMNS,
  communityOf,
  sameCommunity,
  type MemberType,
} from '@/lib/community/memberType'

export type PairGateDenial =
  /** Missing id, or the same member twice. Never reached the database. */
  | 'invalid_pair'
  /** The read did not answer — permission, network, timeout. Retryable; NOT a factual claim. */
  | 'unavailable'
  /** One or both profile rows do not exist. */
  | 'profile_missing'
  /** A row exists but its member_type is absent or unrecognised. Never defaults to professional. */
  | 'unknown_member_type'
  /** Both communities resolved, and they differ. The boundary. */
  | 'cross_community'

export type PairGateResult =
  | { allowed: true; a: MemberType; b: MemberType }
  | { allowed: false; reason: PairGateDenial }

/** The single row shape this module reads. Deliberately one column — see the module header. */
interface CommunityRow {
  id: string
  member_type?: string | null
}

/**
 * May these two members be paired?
 *
 * Reads exactly `id, member_type` for the two ids, as service_role (migration 058 removed the
 * browser's SELECT on public.profiles, and this must work from any server context). It reads
 * nothing else: this function decides one thing, and a wider column list would make it a
 * convenient place to smuggle a profile read into a code path that has no business doing one.
 */
export async function checkPairCommunity(userAId: string, userBId: string): Promise<PairGateResult> {
  if (!userAId || !userBId || userAId === userBId) {
    return { allowed: false, reason: 'invalid_pair' }
  }

  const read = await readProfilesByIds<CommunityRow>(
    [userAId, userBId],
    `id, ${MEMBER_TYPE_COLUMNS}`,
    'community-pair-gate',
  )
  if (!read.ok) return { allowed: false, reason: 'unavailable' }

  const rowA = read.profiles.find((p) => p.id === userAId)
  const rowB = read.profiles.find((p) => p.id === userBId)
  if (!rowA || !rowB) return { allowed: false, reason: 'profile_missing' }

  const a = communityOf(rowA)
  const b = communityOf(rowB)
  // communityOf returns null rather than guessing, so an absent or misspelled value lands here and
  // is refused — it is never coerced to 'professional' and quietly paired with real professionals.
  if (a === null || b === null) return { allowed: false, reason: 'unknown_member_type' }

  // sameCommunity() is the in-memory mirror of the SQL predicate, used rather than `a === b` so
  // there is exactly one place where "same community" is defined for TypeScript.
  if (!sameCommunity(rowA, rowB)) return { allowed: false, reason: 'cross_community' }

  return { allowed: true, a, b }
}

/**
 * Whether a denial is a transport fault (caller should offer a retry) rather than an answer about
 * the pair (caller should state the refusal). Both refuse the write; only the wording differs.
 */
export function isRetryableDenial(reason: PairGateDenial): boolean {
  return reason === 'unavailable'
}
