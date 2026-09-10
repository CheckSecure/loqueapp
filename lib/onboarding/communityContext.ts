/**
 * lib/onboarding/communityContext.ts — which community an invitee is being onboarded INTO,
 * resolved BEFORE their first profile row exists.
 *
 * ─── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────────────────────────
 * profiles.member_type is bound at the first profile INSERT by migration 100's
 * tg_profiles_provision_bind(), and is immutable afterwards (migration 099). So during onboarding —
 * the one screen that runs BEFORE that INSERT — there is no profile to read a community from, and
 * the surface that has to choose which questions to ask has nothing to ask.
 *
 * The answer already exists on the waitlist row: migration 099's `intended_member_type`, set by an
 * administrator before the invitation is issued. public.resolve_intended_member_type(text) is the
 * function 099 built to read it, and this module is its only application-side caller.
 *
 * ─── WHAT THIS IS NOT ─────────────────────────────────────────────────────────────────────────
 * NOT an authorization boundary, and nothing downstream may treat it as one. It decides which FORM
 * to render. Migration 100 decides what is actually written: may_provision_profile() authorizes the
 * INSERT and tg_profiles_provision_bind() writes member_type from the same waitlist intent, inside
 * the same statement. If this module and the trigger ever disagree, the trigger wins and the write
 * is refused — a wrong answer here can only ever produce a wrong-looking form, never a wrong
 * community.
 *
 * NOT a conversion mechanism. Nothing here writes.
 *
 * ─── WHY IT IS SERVER-ONLY ────────────────────────────────────────────────────────────────────
 * resolve_intended_member_type is `REVOKE ALL … FROM PUBLIC, anon, authenticated` /
 * `GRANT EXECUTE … TO service_role` (migration 099). It therefore CANNOT be called from the browser,
 * and this module must never be imported into a client component. That is deliberate: the argument
 * is an email address, and an RPC that maps an address to a community is not something to expose to
 * an unauthenticated caller enumerating addresses.
 *
 * get_my_profile() is deliberately NOT extended to carry member_type. Its migration-057 contract is
 * an explicit column allowlist that "excludes … any future column", and nothing in the onboarding or
 * dashboard path needs a client-side read: every consumer is a server component or a route handler.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import {
  DEFAULT_MEMBER_TYPE, isMemberType, type MemberType,
} from '@/lib/community/memberType'

/**
 * Why the resolver answered the way it did. Returned alongside the community so a caller can log
 * the distinction; every value except 'resolved' still yields DEFAULT_MEMBER_TYPE.
 */
export type CommunityResolution =
  | 'resolved'       // exactly one live waitlist intent
  | 'ambiguous'      // more than one distinct live intent for this address
  | 'not_found'      // no live waitlist row
  | 'unavailable'    // the RPC itself failed (permission, network, unapplied migration)

export interface OnboardingCommunityContext {
  /** What to render. NEVER an authorization input. */
  community: MemberType
  /** Why. Aggregate-safe: carries no address and no row id. */
  resolution: CommunityResolution
}

/**
 * Every non-'resolved' outcome, and every unrecognised member_type, lands here.
 *
 * THE DIRECTION MATTERS. Defaulting to Professional means a failure shows the existing form to
 * someone who should have seen the student one — visibly wrong, trivially recoverable, and the
 * member is refused at the write anyway if they truly are not authorized. Defaulting to Next would
 * mean a resolver failure silently presented the student experience to a professional invitee. One
 * of these is a UI bug; the other looks like a community boundary failure.
 */
const FAIL_CLOSED: MemberType = DEFAULT_MEMBER_TYPE

/**
 * Resolve the community for an onboarding invitee.
 *
 * `sessionEmail` MUST come from `supabase.auth.getUser()` — the verified session — and never from a
 * request body, query string, header, form field or client prop. This function cannot enforce that
 * itself, which is why it is named for it and why its only caller reads the session immediately
 * before calling. An address supplied by a caller would turn a UI hint into an enumeration oracle.
 *
 * Never throws. Every failure path returns Professional.
 */
export async function resolveOnboardingCommunity(
  sessionEmail: string | null | undefined,
): Promise<OnboardingCommunityContext> {
  const email = (sessionEmail ?? '').trim()
  // No address is 'not_found' by the RPC's own contract (it returns not_found for an empty string).
  // Short-circuiting keeps an anonymous or email-less session from making a pointless round trip.
  if (!email) return { community: FAIL_CLOSED, resolution: 'not_found' }

  try {
    const { data, error } = await createAdminClient()
      .rpc('resolve_intended_member_type', { p_email: email })

    if (error) {
      // CLASS ONLY — no address, no row, no raw provider text. This line reaches production logs.
      console.warn('[onboarding] community resolution unavailable',
        JSON.stringify({ code: (error as any)?.code ?? 'unknown' }))
      return { community: FAIL_CLOSED, resolution: 'unavailable' }
    }

    const outcome = (data as any)?.outcome

    if (outcome === 'resolved') {
      const raw = (data as any)?.member_type
      // A 'resolved' outcome carrying a value this build does not recognise is treated as a failure,
      // not coerced. isMemberType is the same guard the matching code uses, so there is exactly one
      // definition of "is this a community" in TypeScript.
      if (isMemberType(raw)) return { community: raw, resolution: 'resolved' }
      console.warn('[onboarding] community resolution returned an unrecognised member_type')
      return { community: FAIL_CLOSED, resolution: 'unavailable' }
    }

    if (outcome === 'ambiguous') return { community: FAIL_CLOSED, resolution: 'ambiguous' }
    if (outcome === 'not_found') return { community: FAIL_CLOSED, resolution: 'not_found' }

    // An outcome string this build has never seen. Same treatment as an error: fail closed.
    return { community: FAIL_CLOSED, resolution: 'unavailable' }
  } catch {
    // The RPC is absent (migration 099 unapplied), the client could not be built, or the network
    // failed. Onboarding must still render — it just renders the Professional form.
    console.warn('[onboarding] community resolution threw')
    return { community: FAIL_CLOSED, resolution: 'unavailable' }
  }
}
