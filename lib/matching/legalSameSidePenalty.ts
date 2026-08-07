/**
 * Same-side legal marketplace penalty (PART 5 / PART 6).
 *
 * A "same-side legal" pair is two people who both sit on the LAW-FIRM side of the
 * legal market — e.g. a Law Firm Partner introduced to another Law Firm Partner or a
 * law-firm associate/counsel. These introductions are usually low value (competitors,
 * not clients or referral sources). We DEMOTE them with a strong RANKING penalty so
 * the engines prefer CROSS-MARKET legal pairings — a law-firm lawyer ↔ General Counsel,
 * Deputy GC, Chief Legal Officer, In-House Counsel, Legal Operations, compliance
 * leadership, corporate executives, PE/investors, government, or board/advisory roles.
 *
 * It is NOT an absolute ban: a same-side pair can still surface when no better
 * alternative exists — the penalty only lowers its rank, it never removes the pair.
 *
 * Detection uses the controlled `role_type` enum ONLY (free-text titles are display-
 * only and never feed scoring). 'Law Firm Partner' → partner; any other 'Law Firm …'
 * value (e.g. 'Law Firm Attorney'/'Law firm attorney') → attorney. Every non-law-firm
 * role — GC, DGC, CLO, In-House Counsel, Legal Operations, corporate, investor,
 * government, board — classifies as null and receives NO penalty, so those preferred
 * alternatives naturally outrank same-side legal peers.
 *
 * This single helper is reused IDENTICALLY by both live scorers
 * (lib/generate-recommendations.ts ranking stage and lib/matching/batch-scoring.ts
 * scoreMatch), so the two engines stay behaviorally aligned.
 */

export type LawFirmRole = 'partner' | 'attorney' | null

/** Exact penalty magnitudes (subtracted from a candidate's score). */
export const LEGAL_SAME_SIDE_PENALTY = {
  partnerPartner: 60,   // Partner ↔ Partner — very strongly penalized
  partnerAttorney: 45,  // Partner ↔ law-firm Attorney/Counsel/Associate/Of Counsel — strongly penalized
  attorneyAttorney: 30, // law-firm Attorney ↔ law-firm Attorney — penalized
} as const

/** Classify a profile's LAW-FIRM side from its controlled role_type, or null if not a law-firm role. */
export function lawFirmRole(profile: { role_type?: string | null } | null | undefined): LawFirmRole {
  const rt = String(profile?.role_type ?? '').toLowerCase()
  if (!rt.includes('law firm')) return null // GC / in-house / corporate / investor / gov / board → no penalty
  return rt.includes('partner') ? 'partner' : 'attorney'
}

/**
 * The (non-positive) penalty for introducing `a` to `b`. Symmetric. Returns 0 unless
 * BOTH endpoints are law-firm roles (a same-side legal pair). Any cross-market or
 * non-law-firm pairing returns 0.
 */
export function legalSameSidePenalty(
  a: { role_type?: string | null } | null | undefined,
  b: { role_type?: string | null } | null | undefined,
): number {
  const ra = lawFirmRole(a)
  const rb = lawFirmRole(b)
  if (!ra || !rb) return 0
  if (ra === 'partner' && rb === 'partner') return -LEGAL_SAME_SIDE_PENALTY.partnerPartner
  if (ra === 'partner' || rb === 'partner') return -LEGAL_SAME_SIDE_PENALTY.partnerAttorney
  return -LEGAL_SAME_SIDE_PENALTY.attorneyAttorney
}

/** True when this is a SAME-SIDE legal pair (both law-firm roles). */
export function isSameSideLegalPair(
  a: { role_type?: string | null } | null | undefined,
  b: { role_type?: string | null } | null | undefined,
): boolean {
  return !!lawFirmRole(a) && !!lawFirmRole(b)
}

/**
 * A same-side legal edge that INVOLVES a law-firm PARTNER (partner↔partner or
 * partner↔attorney). This is the edge the CROSS-MARKET-FIRST product rule targets:
 * a Law Firm Partner is filled from cross-market candidates before any of these.
 * Used by the batch engine's primary selection pass (same-side-partner edges are
 * excluded there and reintroduced only as a coverage fallback).
 */
export function isSameSideLegalPartnerEdge(
  a: { role_type?: string | null } | null | undefined,
  b: { role_type?: string | null } | null | undefined,
): boolean {
  const ra = lawFirmRole(a)
  const rb = lawFirmRole(b)
  return !!ra && !!rb && (ra === 'partner' || rb === 'partner')
}

/**
 * CROSS-MARKET-FIRST composition for a law-firm-side recipient's ranked candidate
 * list. Partitions candidates into cross-market (non-law-firm) vs same-side law firm,
 * preserving the score order within each group, and returns cross-market FIRST with
 * same-side appended as a fallback. A top-N slice therefore fills from cross-market
 * candidates before ever using a same-side law-firm peer — same-side is used only when
 * there aren't enough cross-market candidates to fill the batch. Non-law-firm recipients
 * are returned unchanged.
 */
export function crossMarketFirstForLawFirm(
  candidates: any[],
  recipient: { role_type?: string | null } | null | undefined,
): any[] {
  if (!lawFirmRole(recipient)) return candidates
  const crossMarket: any[] = []
  const sameSide: any[] = []
  for (const c of candidates) {
    if (lawFirmRole(c)) sameSide.push(c)
    else crossMarket.push(c)
  }
  return [...crossMarket, ...sameSide]
}
