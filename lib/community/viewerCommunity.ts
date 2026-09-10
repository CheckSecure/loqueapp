/**
 * lib/community/viewerCommunity.ts — the caller's OWN community, read authoritatively, server-side.
 *
 * ─── WHY THIS EXISTS SEPARATELY FROM THE LAYOUT'S memberType PROP ─────────────────────────────
 * app/dashboard/layout.tsx resolves the same value and hands it to Sidebar/MobileNav. That prop is
 * PRESENTATION CONTEXT: it decides what chrome to draw, it travels to a client component, and a
 * client component holding `memberType='next'` proves nothing about who is calling.
 *
 * A surface that must be CLOSED to a community cannot be built on that. It has to establish the
 * caller's community itself, from the session, on the server, on every request — which is what this
 * function is for. The two paths deliberately do not share a value: hiding a nav link and refusing a
 * request are different jobs, and step 2 of the Andrel Next build ships the refusal BEFORE the
 * hiding precisely so that the refusal is proven to work with the link still visible.
 *
 * ─── WHAT MAKES IT AUTHORITATIVE ──────────────────────────────────────────────────────────────
 *   • the id comes from the verified session (supabase.auth.getUser()), never from input;
 *   • the read is service_role against public.profiles — the base table, not a view or a cache;
 *   • member_type on that row was written by migration 100's tg_profiles_provision_bind() at INSERT
 *     and is immutable under migration 099's BEFORE UPDATE trigger, so the row cannot be talked into
 *     a different community by anything the caller does.
 *
 * ─── WHAT IT IS NOT ───────────────────────────────────────────────────────────────────────────
 * NOT the community-pairing authority. public.community_pair_allowed() (migration 095) governs which
 * members may be RELATED to each other, and nothing here loosens or replaces it. This answers a
 * narrower question: may this caller use this product surface at all.
 *
 * NOT a generic bypass. There is no "skip the community check" argument and there must never be one.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import { communityOf, DEFAULT_MEMBER_TYPE, type MemberType } from '@/lib/community/memberType'

/**
 * The community of the member whose id this is.
 *
 * `userId` MUST come from the verified session. Passing a caller-supplied id would turn every gate
 * built on this into a way to act as somebody else, so no route handler here reads an id from a
 * body, query or header.
 *
 * FAILS TO PROFESSIONAL, deliberately, and this is the safe direction FOR THIS QUESTION. The gates
 * below refuse Next; defaulting a failed read to Next would deny professionals their own products
 * whenever the database hiccuped. The population at risk in the other direction is a Next member
 * reaching a Professional surface during a profiles read failure — visible, transient, and
 * non-destructive, because every WRITE they could then attempt is still gated by its own ownership
 * and eligibility checks, and every relationship they could form is still gated by
 * community_pair_allowed(). Availability of the Professional product wins over a UI-scope refusal
 * that no data depends on.
 */
export async function viewerCommunity(userId: string): Promise<MemberType> {
  try {
    const { data, error } = await createAdminClient()
      .from('profiles')
      .select('member_type')
      .eq('id', userId)
      .maybeSingle()

    if (error) {
      // CLASS ONLY — no id, no address, no raw message.
      console.warn('[community] viewer community read failed',
        JSON.stringify({ code: (error as any)?.code ?? 'unknown' }))
      return DEFAULT_MEMBER_TYPE
    }
    // communityOf() returns null for absent/null/unrecognised rather than coercing; a member with no
    // profile row yet is not a Next member, and is about to be sent to onboarding anyway.
    return communityOf(data) ?? DEFAULT_MEMBER_TYPE
  } catch {
    console.warn('[community] viewer community read threw')
    return DEFAULT_MEMBER_TYPE
  }
}

/** True when this caller is an Andrel Next member. The condition every gate below tests. */
export async function viewerIsNext(userId: string): Promise<boolean> {
  return (await viewerCommunity(userId)) === 'next'
}

/**
 * Where a Next member is sent when they reach a Professional-only surface.
 *
 * Introductions rather than /dashboard: it is the one product both communities share, it is the
 * dashboard's own post-onboarding landing, and it cannot itself redirect back here.
 */
export const NEXT_REDIRECT_TARGET = '/dashboard/introductions'

/**
 * The refusal body for a Professional-only API, and the reason it says so little.
 *
 * It names no opportunity, no member, no community and no reason. A caller who is not entitled to
 * this product does not learn from the response whether the opportunity they addressed exists, who
 * created it, or that a second community exists at all. 403 rather than 404 because the resource
 * question is not what was answered — the caller was.
 */
export const COMMUNITY_FORBIDDEN = { error: 'Not available on your account.' } as const
export const COMMUNITY_FORBIDDEN_STATUS = 403
