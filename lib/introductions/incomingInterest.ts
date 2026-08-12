// Incoming interest — the SINGLE source of truth for "someone expressed interest
// in you and is waiting for your response."
//
// Both the Introductions page (the "Interested in you" surface) and the
// engagement-reminders cron ("Someone is waiting on your response") derive their
// notion of an *actionable* incoming item from the functions here, so the two can
// never drift. If an item is not returned by `fetchActionableIncomingInterest`, no
// reminder is sent for it and it does not render as an accept-able card.
//
// An incoming item is actionable when a member (the "expresser") has expressed
// interest — a member-initiated intro_request with status `approved` targeting the
// viewer — and that interest can still be acted on: no match exists yet, the
// expresser is active, and the pair is not same-company (which the mutual-match
// path rejects). Admin-initiated intros are excluded here — they have their own
// surface ("Introduced by Andrel") and their own nudge (`admin_intro_nudge`).
//
// Note: actionability does NOT depend on whether the viewer received their own
// reciprocal recommendation card. The surface is built from the expresser's row,
// so a viewer who never got a reciprocal suggestion can still see and accept.

import { isSameCompany } from '@/lib/matching/same-company'

/** The status an expresser's member-initiated row carries once interest is expressed. */
export const EXPRESSER_EXPRESSED_STATUS = 'approved' as const

export interface IncomingInterestRequesterProfile {
  id: string
  full_name: string | null
  title: string | null
  exact_job_title: string | null
  company: string | null
  location: string | null
  bio: string | null
  avatar_url: string | null
  seniority: string | null
  role_type: string | null
  expertise?: unknown
  interests?: unknown
  account_status?: string | null
}

export interface IncomingInterestItem {
  introRequestId: string
  requesterId: string
  targetId: string
  createdAt: string
  matchReason: string | null
  requester: IncomingInterestRequesterProfile
}

/**
 * Pure classifier: is a single incoming intro_request an actionable item for its
 * target? Used by the DB fetch below and unit-tested directly so the exact
 * definition is pinned. Keeping it pure means the reminder cron and the page apply
 * byte-identical rules.
 */
export function isActionableIncoming(args: {
  status: string
  isAdminInitiated: boolean
  hasMatch: boolean
  requesterActive: boolean
  sameCompany: boolean
  /** True when the expresser's row belongs to a reciprocal pair (pair_id set). */
  isReciprocalPair?: boolean
}): boolean {
  // PRIVACY: a reciprocal pair NEVER surfaces one member's interest to the other. Both members act
  // on their OWN "Introduced by Andrel" card; the pair finalizes only when both independently
  // express interest (via express-interest's reverse check), never through this one-sided surface.
  if (args.isReciprocalPair) return false
  if (args.isAdminInitiated) return false // has its own surface + nudge
  if (args.status !== EXPRESSER_EXPRESSED_STATUS) return false // not (or no longer) expressed
  if (args.hasMatch) return false // already connected — nothing to respond to
  if (!args.requesterActive) return false // expresser deactivated — cannot connect
  if (args.sameCompany) return false // mutual-match path rejects same-company pairs
  return true
}

const REQUESTER_COLS =
  'id, full_name, title, exact_job_title, company, location, bio, avatar_url, seniority, role_type, expertise, interests, account_status'

/**
 * All actionable incoming-interest items for `viewerId`, most recent first.
 *
 * Read-only. `db` may be a service-role or RLS-scoped client; the page passes its
 * user-scoped client (RLS lets a member read rows that target them), the cron
 * passes the admin client. Applies the SAME `isActionableIncoming` predicate the
 * reminder gate uses. No writes, no mutation of intro_requests rows.
 */
export async function fetchActionableIncomingInterest(
  db: any,
  viewerId: string,
): Promise<IncomingInterestItem[]> {
  // 1. Candidate rows: member-initiated interest expressed AT the viewer. RECIPROCAL pairs
  //    (pair_id set) are EXCLUDED at the query so one member's interest never reaches the other
  //    through this surface — reciprocal pairs finalize only via each member's own card.
  const { data: rows } = await db
    .from('intro_requests')
    .select(
      `id, requester_id, target_user_id, status, created_at, is_admin_initiated, pair_id, match_reason, requester:profiles!requester_id(${REQUESTER_COLS})`,
    )
    .eq('target_user_id', viewerId)
    .eq('is_admin_initiated', false)
    .eq('status', EXPRESSER_EXPRESSED_STATUS)
    .is('pair_id', null)
    .order('created_at', { ascending: false })

  const candidates = (rows ?? []) as any[]
  if (candidates.length === 0) return []

  const requesterIds = Array.from(new Set(candidates.map((r) => r.requester_id)))

  // 2. Existing matches between the viewer and any candidate expresser (either
  //    direction) — a matched pair has nothing to respond to.
  const { data: matchRows } = await db
    .from('matches')
    .select('user_a_id, user_b_id')
    .or(`user_a_id.eq.${viewerId},user_b_id.eq.${viewerId}`)
  const matchedWithViewer = new Set<string>()
  for (const m of (matchRows ?? []) as any[]) {
    if (m.user_a_id === viewerId) matchedWithViewer.add(m.user_b_id)
    if (m.user_b_id === viewerId) matchedWithViewer.add(m.user_a_id)
  }

  // 3. Viewer's own company, for the same-company gate.
  const { data: viewerRow } = await db
    .from('profiles')
    .select('company')
    .eq('id', viewerId)
    .maybeSingle()
  const viewerCompany = (viewerRow as any)?.company ?? null

  // De-dupe by expresser: one card per person even if multiple approved rows exist
  // (keep the most recent, which is first after the order-by above).
  const seen = new Set<string>()
  const items: IncomingInterestItem[] = []
  for (const r of candidates) {
    if (seen.has(r.requester_id)) continue
    const requester = r.requester as IncomingInterestRequesterProfile | null
    if (!requester) continue
    const actionable = isActionableIncoming({
      status: r.status,
      isAdminInitiated: r.is_admin_initiated === true,
      hasMatch: matchedWithViewer.has(r.requester_id),
      requesterActive: (requester.account_status ?? 'active') === 'active',
      sameCompany: isSameCompany({ company: viewerCompany }, { company: requester.company }),
      isReciprocalPair: r.pair_id != null, // defense-in-depth alongside the query's .is('pair_id', null)
    })
    if (!actionable) continue
    seen.add(r.requester_id)
    items.push({
      introRequestId: r.id,
      requesterId: r.requester_id,
      targetId: r.target_user_id,
      createdAt: r.created_at,
      matchReason: r.match_reason ?? null,
      requester,
    })
  }
  void requesterIds // referenced for clarity; matches fetch is viewer-scoped
  return items
}
