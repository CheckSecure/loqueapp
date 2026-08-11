/**
 * Pure classification + admin-approval decision logic for the Admin → Intro Requests page.
 *
 * Every decision here is derived from STRUCTURAL fields (status, pair_id, is_admin_initiated,
 * matched state, and the counterpart's independent consent) — never from a UI label. The server
 * action and the page both consume this module so the interface and the enforcement agree.
 *
 * SAFETY MODEL: an admin "Approve" click may NEVER manufacture consent. A pair connects only
 * through the canonical mutual finalizer, and only when both members have independently consented
 * (or an explicit admin-facilitated policy whose consent requirements are already satisfied).
 */

/**
 * A member independently CONSENTS to connect by their OWN authenticated action, which writes an
 * outbound row in one of these statuses. `admin_pending` (an admin-created, not-yet-accepted row),
 * `suggested`/`queued` (a displayed recommendation), and `accepted_pending_payment` (an
 * administrative/payment state — no member flow writes it) are NOT consent.
 */
export const ACTING_CONSENT_STATUSES = ['approved', 'accepted'] as const
/**
 * The COUNTERPART is considered to have expressed interest when their own outbound row is a consent
 * status OR a legacy member-initiated 'pending' (the pre-reciprocal "I want an intro" action, only
 * ever created by a member). Never includes `admin_pending`/`suggested`.
 */
export const COUNTERPART_INTEREST_STATUSES = ['approved', 'accepted', 'pending'] as const

/** Back-compat alias — the member-consent set (own affirmative acceptance). */
export const CONSENT_STATUSES = ACTING_CONSENT_STATUSES
export function isConsentStatus(s: string | null | undefined): boolean {
  return s === 'approved' || s === 'accepted'
}

/**
 * Both members have independently consented iff the ACTING member has an outbound consent row AND
 * the COUNTERPART has an outbound interest row. Pure over the two directional rows. This is the
 * invariant the finalizer revalidates immediately before the transactional RPC — an admin click,
 * `is_admin_initiated`, `admin_pending`, or a displayed recommendation can never satisfy it.
 */
export function bothMembersConsented(
  rows: Array<{ requester_id: string; target_user_id: string; status: string }>,
  actingUserId: string,
  otherUserId: string,
): boolean {
  if (!actingUserId || !otherUserId || actingUserId === otherUserId) return false
  const acting = (rows ?? []).some(
    (r) => r.requester_id === actingUserId && r.target_user_id === otherUserId &&
      (ACTING_CONSENT_STATUSES as readonly string[]).includes(r.status),
  )
  const other = (rows ?? []).some(
    (r) => r.requester_id === otherUserId && r.target_user_id === actingUserId &&
      (COUNTERPART_INTEREST_STATUSES as readonly string[]).includes(r.status),
  )
  return acting && other
}

/** Canonical unordered pair key so (A,B) and (B,A) collapse; null for self/invalid. */
export function introPairKey(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a || !b || a === b) return null
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

export type IntroCategory =
  | 'reciprocal_live'   // pair-governed reciprocal card — connects automatically, never admin-approved
  | 'matched'           // the pair is already connected (either orientation)
  | 'admin_review'      // admin/concierge-initiated, not yet matched — an explicit admin workflow
  | 'flagged_review'    // safety/eligibility flag — needs human review
  | 'legacy_read_only'  // legacy one-sided / non-admin / no pair — read-only history, never approvable

export interface IntroRecord {
  status: string
  pair_id: string | null
  is_admin_initiated: boolean | null
}
export interface IntroContext {
  isMatched: boolean            // pair already in `matches` (either orientation)
  counterpartConsented: boolean // the OTHER member's row independently expresses interest
  flagged?: boolean             // safety/eligibility flag on the record
}

/**
 * Assign a record to exactly one category from its structural fields. Order matters:
 * matched wins (terminal), then pair-governed reciprocal, then explicit review lanes, else legacy.
 */
export function classifyIntro(rec: IntroRecord, ctx: IntroContext): IntroCategory {
  if (ctx.isMatched) return 'matched'
  if (rec.pair_id != null) return 'reciprocal_live'      // pair lifecycle governs it — not admin-actionable
  if (ctx.flagged === true) return 'flagged_review'
  if (rec.is_admin_initiated === true) return 'admin_review'
  return 'legacy_read_only'                               // non-admin, no pair (incl. legacy 'pending')
}

// NOTE: there is deliberately NO decideAdminApprove. An admin click can never stand in for either
// member's consent, and no product policy authorizes an admin-forced connection. The admin surface
// may review / flag / cancel / archive only; finalization happens exclusively through the two
// member-facing acceptance routes once bothMembersConsented() holds. See ADMIN_APPROVE_DISABLED_MSG.

/** Copy shown when a (defensively-retained) admin approve entry point is invoked — it never acts. */
export const ADMIN_APPROVE_DISABLED_MSG =
  'Admin approval cannot connect members. Both members must independently accept — this happens automatically once each expresses interest.'

/** Whether adminReject may archive this record. Reciprocal (pair-governed) rows are refused. */
export function decideAdminReject(rec: Pick<IntroRecord, 'pair_id'>): { allow: boolean; reason?: 'reciprocal_pair' } {
  if (rec.pair_id != null) return { allow: false, reason: 'reciprocal_pair' }
  return { allow: true }
}

// ── Page bucketing (pure; counts are unique PAIRS, not directional rows) ──────────────
export interface IntroRow extends IntroRecord {
  id: string
  requester_id: string
  target_user_id: string
  flagged?: boolean | null
  [k: string]: any
}
export interface BucketedRow extends IntroRow { category: IntroCategory }
export interface BucketedPage {
  needsReview: BucketedRow[]      // admin_review + flagged_review, deduped by pair
  reciprocalLive: BucketedRow[]   // one card per pair
  legacy: BucketedRow[]           // legacy_read_only, all rows (read-only history)
  counts: {
    connections: number           // unique matched pairs (from `matches`)
    reciprocalPairs: number
    reciprocalRows: number
    needsReviewPairs: number
    legacyPairs: number
    legacyRows: number
  }
}

/**
 * Bucket every intro_requests row into the four page sections using structural context only.
 * `matches` supplies both the matched-state context and the deduplicated Connections count.
 * Deterministic regardless of input order (rows keyed/sorted by pair then id).
 */
export function bucketIntroRecords(rows: IntroRow[], matches: Array<{ user_a_id?: string; user_b_id?: string }>): BucketedPage {
  const matchKeys = new Set<string>()
  for (const m of matches ?? []) { const k = introPairKey(m.user_a_id, m.user_b_id); if (k) matchKeys.add(k) }

  // Directional consent set: `${requester}->${target}` for rows whose OWN status expresses interest.
  const consentDir = new Set<string>()
  for (const r of rows ?? []) if (isConsentStatus(r.status)) consentDir.add(`${r.requester_id}->${r.target_user_id}`)

  const categorized: BucketedRow[] = (rows ?? []).map((r) => {
    const ctx: IntroContext = {
      isMatched: matchKeys.has(introPairKey(r.requester_id, r.target_user_id) ?? '\0'),
      counterpartConsented: consentDir.has(`${r.target_user_id}->${r.requester_id}`),
      flagged: r.flagged === true,
    }
    return { ...r, category: classifyIntro(r, ctx) }
  })

  const byPairFirst = (list: BucketedRow[]): BucketedRow[] => {
    const seen = new Set<string>()
    const out: BucketedRow[] = []
    // Sort for deterministic representative selection.
    const sorted = [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const r of sorted) {
      const k = introPairKey(r.requester_id, r.target_user_id) ?? r.id
      if (seen.has(k)) continue
      seen.add(k); out.push(r)
    }
    return out
  }

  const reciprocalAll = categorized.filter((r) => r.category === 'reciprocal_live')
  const needsReviewAll = categorized.filter((r) => r.category === 'admin_review' || r.category === 'flagged_review')
  const legacyAll = categorized.filter((r) => r.category === 'legacy_read_only')
  const reciprocalLive = byPairFirst(reciprocalAll)
  const needsReview = byPairFirst(needsReviewAll)

  const uniquePairs = (list: BucketedRow[]) => new Set(list.map((r) => introPairKey(r.requester_id, r.target_user_id) ?? r.id)).size

  return {
    needsReview,
    reciprocalLive,
    legacy: legacyAll,
    counts: {
      connections: matchKeys.size,
      reciprocalPairs: reciprocalLive.length,
      reciprocalRows: reciprocalAll.length,
      needsReviewPairs: needsReview.length,
      legacyPairs: uniquePairs(legacyAll),
      legacyRows: legacyAll.length,
    },
  }
}
