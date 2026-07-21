/**
 * Canonical company registry — the authoritative alias/synonym → company map.
 *
 * IDENTITY DATA ONLY: canonical name, authoritative domain, and aliases. It does
 * NOT store descriptions, industries, headquarters, or logos — that metadata is
 * always obtained by enriching the authoritative homepage (or left null). This
 * keeps the registry a small, verifiable identity source and avoids hand-curated
 * content drifting out of date.
 *
 * WHY THIS EXISTS
 * Company pages are derived from free-text `profiles.company` values. Without a
 * registry, discovery would have to *guess* a domain from the name, which fails
 * for abbreviated/acronym domains (dwt.com, akamai.com, btlaw.com, bd.com) and
 * mis-resolves short/acronym names (BD → a parked page; Wonder → the wrong one).
 * The registry maps known variants to one canonical company with the correct
 * domain, so (a) every variant collapses to one canonical slug/page and (b)
 * enrichment scrapes the CORRECT homepage.
 *
 * MATCHING IS EXACT (normalized): only a profile whose company normalizes to a
 * listed name/alias resolves here. "TKO Strength & Performance", "BD Sports",
 * "Wonder Bread" normalize to different keys and DO NOT match. See
 * `ambiguousAliases` for the review path on short/acronym keys.
 *
 * HOW TO EXTEND: add DATA, not code — canonical `name`, authoritative bare
 * `domain`, and `aliases`. Put any short/acronym key that a FUTURE unrelated
 * profile could legitimately use in `ambiguousAliases` so it is flagged for
 * review rather than silently trusted.
 */

export type CanonicalCompany = {
  /** Canonical display name (also determines the canonical slug). */
  name: string
  /** Authoritative homepage host, bare (no scheme, no leading www). */
  domain: string
  /** Additional name variants that resolve to this company. */
  aliases: string[]
  /**
   * Short/acronym keys (a subset of name+aliases) ambiguous enough that a FUTURE
   * unrelated profile could legitimately use them. They still resolve (current
   * members are known-correct), but `isAmbiguousCompanyName` flags them so the
   * migration/admin surface routes them through review instead of trusting them.
   */
  ambiguousAliases?: string[]
}

export const COMPANY_REGISTRY: CanonicalCompany[] = [
  // ── Law firms (abbreviated/acronym domains a guesser can't reach) ──
  { name: 'Davis Wright Tremaine LLP', domain: 'dwt.com', aliases: ['DWT', 'Davis Wright Tremaine'] },
  { name: 'Eversheds Sutherland', domain: 'eversheds-sutherland.com', aliases: ['Eversheds', 'Eversheds Sutherland (US) LLP', 'Eversheds Sutherland US', 'Eversheds Sutherland US LLP'] },
  { name: 'Manatt, Phelps & Phillips', domain: 'manatt.com', aliases: ['Manatt', 'Manatt Phelps', 'Manatt Phelps & Phillips', 'Manatt, Phelps & Phillips, LLP'] },
  { name: 'Baker Botts L.L.P.', domain: 'bakerbotts.com', aliases: ['Baker Botts', 'Baker Botts LLP'] },
  { name: 'Barnes & Thornburg LLP', domain: 'btlaw.com', aliases: ['Barnes & Thornburg', 'Barnes Thornburg'] },
  { name: 'Hughes Hubbard & Reed LLP', domain: 'hugheshubbard.com', aliases: ['Hughes Hubbard', 'Hughes Hubbard & Reed', 'Hughes Hubbard and Reed'] },
  { name: 'Womble Bond Dickinson', domain: 'womblebonddickinson.com', aliases: ['Womble', 'Womble Bond Dickinson US', 'Womble Bond Dickinson (US) LLP', 'Womble Carlyle'] },

  // ── Enterprises / brands (short or acronym domains) ──
  { name: 'Becton, Dickinson and Company', domain: 'bd.com', aliases: ['BD', 'Becton Dickinson', 'Becton, Dickinson'], ambiguousAliases: ['BD'] },
  { name: 'FedEx Corporation', domain: 'fedex.com', aliases: ['FedEx', 'Federal Express'] },
  { name: 'T-Mobile US', domain: 't-mobile.com', aliases: ['T-Mobile', 'TMobile', 'T Mobile'] },
  { name: 'Verizon Communications', domain: 'verizon.com', aliases: ['Verizon'] },
  { name: 'Akamai Technologies', domain: 'akamai.com', aliases: ['Akamai'] },
  { name: 'Centene Corporation', domain: 'centene.com', aliases: ['Centene'] },
  { name: 'Cummins Inc.', domain: 'cummins.com', aliases: ['Cummins'] },
  { name: 'TransUnion', domain: 'transunion.com', aliases: ['Trans Union'] },
  { name: 'Crypto.com', domain: 'crypto.com', aliases: ['Crypto'], ambiguousAliases: ['Crypto'] },
  { name: 'TKO Group Holdings', domain: 'tkogrp.com', aliases: ['TKO', 'TKO Group'], ambiguousAliases: ['TKO'] },
  // Marc Lore's food-hall/delivery company — NOT wonder.io (interactive storytelling).
  { name: 'Wonder', domain: 'wonder.com', aliases: ['Wonder Group'], ambiguousAliases: ['Wonder'] },
  { name: 'Zoeller Company', domain: 'zoellerpumps.com', aliases: ['Zoeller', 'Zoeller Pump Company'] },
  { name: 'Motion Picture Association', domain: 'motionpictures.org', aliases: ['MPA', 'MPAA', 'Motion Picture Association of America'] },
  { name: 'Caribou', domain: 'caribou.com', aliases: ['Caribou Financial'], ambiguousAliases: ['Caribou'] },
  { name: 'Irvine Company Office Properties', domain: 'irvinecompanyoffice.com', aliases: ['Irvine Company Office'] },

  // ── Duplicate-identity consolidation: fold Merkle into canonical Dentsu ──
  { name: 'Dentsu', domain: 'dentsu.com', aliases: ['Merkle', 'Dentsu Merkle', 'Dentsu/Merkle', 'Dentsu International', 'Dentsu Aegis Network', 'Merkle Inc'], ambiguousAliases: ['Merkle'] },
]
