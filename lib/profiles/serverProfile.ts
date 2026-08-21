/**
 * Server-authorized reads of the PRIVATE public.profiles table.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 *
 * Migration 058 revoked `SELECT ON public.profiles` from PUBLIC/anon/authenticated. That is the
 * intended A3 posture and must never be undone: a browser session can read its own safe columns
 * through get_my_profile(), and other members only through the discovery-scoped public_profiles
 * view. Neither exposes the base row.
 *
 * What 058 also did — silently — was break every server route that still read the base table with
 * the CALLER's client. Those reads now return a permission error, and code that destructured only
 * `data` saw `null` and reported it as "profile not found". A member trying to nominate someone got
 * a 500 that blamed their own profile for a privilege change.
 *
 * Server code that legitimately needs private columns runs as service_role, which 058 explicitly
 * preserved. This module is that path, and it exists so the fix is one reviewed helper rather than
 * fifteen ad-hoc admin clients.
 *
 * ── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────────────────────────
 *
 * It never grants a browser role anything, and it never collapses a database failure into "missing".
 * `not_found` means the row genuinely is not there; `unavailable` means the read did not answer, and
 * the caller must surface a retryable error rather than a factual claim about the member. Conflating
 * those two is the exact defect this module was written to end.
 *
 * Callers pass an explicit column list. There is deliberately no `select('*')` convenience.
 */

import { createAdminClient } from '@/lib/supabase/admin'

export type ProfileReadFailure =
  /** The row does not exist. A factual, non-retryable answer. */
  | 'not_found'
  /** The read did not answer — permission, network, timeout. NEVER report this as "not found". */
  | 'unavailable'

export type ProfileRead<T> =
  | { ok: true; profile: T }
  | { ok: false; reason: ProfileReadFailure }

export type ProfileListRead<T> =
  | { ok: true; profiles: T[] }
  | { ok: false; reason: 'unavailable' }

/** Class-only logging. No id, no email, no raw database message ever reaches a log line. */
function logClass(where: string, error: unknown) {
  console.error(`[server-profile] ${where} read failed (class):`, (error as any)?.code ?? 'unknown')
}

/**
 * Read one profile by id. `columns` is a PostgREST select list — pass only what is needed.
 */
export async function readProfileById<T = Record<string, unknown>>(
  id: string,
  columns: string,
  where = 'by-id',
): Promise<ProfileRead<T>> {
  if (!id) return { ok: false, reason: 'not_found' }
  const { data, error } = await createAdminClient()
    .from('profiles')
    .select(columns)
    .eq('id', id)
    .maybeSingle()
  if (error) {
    logClass(where, error)
    return { ok: false, reason: 'unavailable' }   // NOT "not_found"
  }
  if (!data) return { ok: false, reason: 'not_found' }
  return { ok: true, profile: data as T }
}

/** Read several profiles by id. A partial result is still `ok`; only a failed query is not. */
export async function readProfilesByIds<T = Record<string, unknown>>(
  ids: readonly string[],
  columns: string,
  where = 'by-ids',
): Promise<ProfileListRead<T>> {
  const wanted = Array.from(new Set(ids.filter(Boolean)))
  if (wanted.length === 0) return { ok: true, profiles: [] }
  const { data, error } = await createAdminClient()
    .from('profiles')
    .select(columns)
    .in('id', wanted)
  if (error) {
    logClass(where, error)
    return { ok: false, reason: 'unavailable' }
  }
  return { ok: true, profiles: (data ?? []) as T[] }
}

/**
 * The eligibility read a member-facing route needs before acting on the caller's behalf.
 *
 * Supabase auth sessions survive deactivation, so account_status must be checked explicitly — and
 * account_status is not one of get_my_profile()'s columns, which is why this cannot be done from
 * the browser at all.
 */
export interface SelfEligibility {
  id: string
  email: string | null
  account_status: string | null
}

export type SelfEligibilityResult =
  | { ok: true; profile: SelfEligibility }
  | { ok: false; reason: 'not_found' | 'unavailable' | 'inactive'; accountStatus?: string | null }

export async function readSelfEligibility(userId: string): Promise<SelfEligibilityResult> {
  const res = await readProfileById<SelfEligibility>(userId, 'id, email, account_status', 'self-eligibility')
  if (!res.ok) return { ok: false, reason: res.reason }
  if (res.profile.account_status !== 'active') {
    return { ok: false, reason: 'inactive', accountStatus: res.profile.account_status }
  }
  return { ok: true, profile: res.profile }
}
