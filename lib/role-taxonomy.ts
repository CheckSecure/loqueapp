/**
 * Canonical role_type taxonomy.
 *
 * Phase A-1 (prior commit, not yet pushed) extracted the four form option
 * arrays into named VIEW_* exports. Phase B (this change) introduces
 * ROLE_CATEGORIES — a structured map of 12 ordered categories → ordered
 * title lists. New users pick from this structured set; their stored
 * role_type is the title string (no schema change).
 *
 * "Other" is a standalone retained value — selectable, but NOT a 13th
 * category. titleToCategory('Other') returns 'Other' as a sentinel.
 *
 * Legacy values present in production but not in ROLE_CATEGORIES titles
 * remain valid-to-store and continue to round-trip through the DB. Edit
 * surfaces show them as a pinned "Current: <value>" option so the user
 * never loses their stored value when editing.
 *
 * Downstream scoring/matching code (lib/scoring.ts roleScores,
 * lib/matching/business-solutions.ts,
 * lib/match-signals.ts) reads role_type values by exact-string or
 * substring match. The map-key drift documented in A-1 preflight (D3)
 * persists unchanged here — Phase B does not address it.
 */

// ─────────────────────────────────────────────────────────────────────
// Phase B — structured taxonomy
// ─────────────────────────────────────────────────────────────────────

/**
 * ROLE_CATEGORIES — 12 categories in display order; titles in display
 * order within each. The keys are the category labels users see; the
 * values are the title lists they pick from.
 *
 * Adding/renaming/removing a title or category is a behavior change.
 * Existing scoring maps (lib/scoring.ts) key off the stored value, so
 * any change here must be audited against those maps.
 */
export const ROLE_CATEGORIES = {
  'Legal': [
    'General Counsel',
    'Chief Legal Officer',
    'In-House Counsel',
    'Deputy General Counsel',
    'Associate General Counsel',
    'Law Firm Partner',
    'Legal Operations',
  ],
  'Executive / C-Suite': [
    'CEO',
    'Founder',
    'President',
    'COO',
    'Chief Strategy Officer',
  ],
  'Finance': [
    'CFO',
    'VP Finance',
    'Controller',
    'Treasurer',
    'Head of FP&A',
  ],
  'HR / People': [
    'CHRO',
    'Chief People Officer',
    'Head of Talent',
    'HR Executive',
  ],
  'Sales / Revenue': [
    'CRO',
    'VP Sales',
    'Head of Business Development',
    'Partnerships Executive',
  ],
  'Marketing': [
    'CMO',
    'VP Marketing',
    'Brand Executive',
  ],
  'Operations': [
    'Operations Executive',
    'Transformation Executive',
  ],
  'Technology / Cybersecurity': [
    'CTO',
    'CIO',
    'CISO',
    'Technology Executive',
    'Cybersecurity Executive',
  ],
  'Government Affairs / Policy': [
    'Government Affairs Executive',
    'Public Policy Executive',
    'Regulatory Affairs Executive',
  ],
  'Investor / Private Equity': [
    'Investor',
    'General Partner',
    'Managing Director',
    'Operating Partner',
    'Portfolio Operations Executive',
  ],
  'Healthcare': [
    'Healthcare Executive',
    'Life Sciences Executive',
  ],
  'Consulting / Advisory': [
    'Consultant',
    'Advisor',
    'Professional Services Executive',
  ],
} as const

export type Category = keyof typeof ROLE_CATEGORIES

/**
 * CATEGORY_LABELS — identity today (key === label). Reserved for future
 * label divergence without renaming stored values.
 */
export const CATEGORY_LABELS: Record<Category, string> = Object.fromEntries(
  (Object.keys(ROLE_CATEGORIES) as Category[]).map((c) => [c, c])
) as Record<Category, string>

// Legacy value → category mapping (derivation only). These values are
// preserved verbatim in the DB; this map is consulted by titleToCategory()
// when the title is not in the structured ROLE_CATEGORIES set.
const LEGACY_TITLE_TO_CATEGORY: Record<string, Category | 'Other'> = {
  // Legal-family legacies
  'In-house Counsel':            'Legal',
  'Law Firm Attorney':           'Legal',
  'Law firm attorney':           'Legal',  // production-only case variant
  'Legal services professional': 'Legal',  // production + scoring.ts roleScores key
  'Compliance':                  'Legal',
  'Risk':                        'Legal',
  'Privacy':                     'Legal',
  'Legal Tech Founder':          'Legal',
  'Legal':                       'Legal',  // bare legacy bucket
  // Government legacies
  'Regulatory Affairs':          'Government Affairs / Policy',
  'Government Affairs':          'Government Affairs / Policy',
  'Government / Policy':         'Government Affairs / Policy',
  'Government / Public Sector':  'Government Affairs / Policy',
  // Other vertical legacies
  'Executive / C-Suite':         'Executive / C-Suite',
  'Investor / VC':               'Investor / Private Equity',
  'Finance Professional':        'Finance',
  'Finance':                     'Finance',     // bare legacy bucket
  'Healthcare Professional':     'Healthcare',
  'Healthcare':                  'Healthcare',  // bare legacy bucket
  // 'Other' is handled specially in titleToCategory() below
}

/**
 * titleToCategory — derive the category a stored role_type value belongs to.
 *
 * - For NEW canonical titles (in ROLE_CATEGORIES): returns the parent category.
 * - For 'Other': returns 'Other' (sentinel — not a real category).
 * - For legacy values (in LEGACY_TITLE_TO_CATEGORY): returns the mapped category.
 * - For unknown values: returns null.
 *
 * Used by edit surfaces to (a) detect when a stored value is a legacy that
 * needs a pinned "Current:" option, and (b) optionally pre-expand the
 * matching category in pickers.
 */
export function titleToCategory(title: string): Category | 'Other' | null {
  if (title === 'Other') return 'Other'
  for (const category of Object.keys(ROLE_CATEGORIES) as Category[]) {
    if ((ROLE_CATEGORIES[category] as readonly string[]).includes(title)) {
      return category
    }
  }
  if (title in LEGACY_TITLE_TO_CATEGORY) {
    return LEGACY_TITLE_TO_CATEGORY[title]
  }
  return null
}

/**
 * isStructuredTitle — true iff the value is in ROLE_CATEGORIES titles or
 * is the 'Other' sentinel. False for legacy values and unknowns.
 *
 * Used by edit surfaces to decide whether to inject the pinned "Current:"
 * option for the stored value.
 */
export function isStructuredTitle(title: string): boolean {
  if (title === 'Other') return true
  for (const category of Object.keys(ROLE_CATEGORIES) as Category[]) {
    if ((ROLE_CATEGORIES[category] as readonly string[]).includes(title)) return true
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────
// Phase C — multi-select targeting helpers
//
// CategoryTitleSelection is the storage shape for "desired connections"
// (profiles.desired_connections) and opportunity targeting
// (opportunities.criteria.target_connections). It is a map from category
// label to a list of titles.
//
//   {}                                  → no preference set
//   { 'Legal': [] }                     → whole Legal category ("anyone in Legal")
//   { 'Legal': ['General Counsel'] }    → specific titles
//
// Phase C never reads this in any scoring/ranking path — capture-only.
// ─────────────────────────────────────────────────────────────────────

export type CategoryTitleSelection = Record<string, string[]>

/** Categories present in the selection. */
export function selectionCategories(sel: CategoryTitleSelection): string[] {
  return Object.keys(sel)
}

/**
 * Flatten to a list of titles. For categories with an empty array (whole-
 * category sentinel), all titles in that category are expanded.
 */
export function selectionTitles(sel: CategoryTitleSelection): string[] {
  const out: string[] = []
  for (const cat of Object.keys(sel)) {
    if (!(cat in ROLE_CATEGORIES)) continue
    const picked = sel[cat]
    if (picked.length === 0) {
      // whole-category sentinel — expand to every title in the category
      for (const t of ROLE_CATEGORIES[cat as Category] as readonly string[]) out.push(t)
    } else {
      for (const t of picked) out.push(t)
    }
  }
  return out
}

/** True when no categories are present (i.e. the user has set no preference). */
export function isEmptySelection(sel: CategoryTitleSelection): boolean {
  return Object.keys(sel).length === 0
}

/**
 * Defensive: drop any category not in ROLE_CATEGORIES and any title not in
 * that category's title list. Never persist unknown taxonomy. Used at every
 * write site (server actions, API route) before the value lands in the DB.
 */
export function validateSelection(sel: unknown): CategoryTitleSelection {
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) return {}
  const out: CategoryTitleSelection = {}
  for (const [cat, titles] of Object.entries(sel as Record<string, unknown>)) {
    if (!(cat in ROLE_CATEGORIES)) continue
    if (!Array.isArray(titles)) continue
    const known = (ROLE_CATEGORIES[cat as Category] as readonly string[])
    const kept = (titles as unknown[]).filter(
      (t): t is string => typeof t === 'string' && known.includes(t)
    )
    out[cat] = kept
  }
  return out
}

interface SelectionCaps {
  maxCategories: number
  maxTitles: number
}

const DEFAULT_CAPS: SelectionCaps = { maxCategories: 5, maxTitles: 15 }

function countTitles(sel: CategoryTitleSelection): number {
  let n = 0
  for (const arr of Object.values(sel)) if (Array.isArray(arr)) n += arr.length
  return n
}

/**
 * Cap-on-add wrapper around validateSelection.
 *
 *   - Strips unknown taxonomy via validateSelection (same as before)
 *   - Caps NET-NEW additions: never shrinks below what's already stored
 *
 * Semantics:
 *   - effective category cap = max(prior categories, caps.maxCategories)
 *   - effective title cap     = max(prior titles, caps.maxTitles)
 *   - When next > effective cap: trim, preserving prior entries first.
 *
 * Called at every desired_connections / target_connections write site. The
 * picker also enforces caps client-side; this is server-side defense-in-depth.
 */
export function validateSelectionWithCaps(
  sel: unknown,
  prior: unknown,
  caps: SelectionCaps = DEFAULT_CAPS
): CategoryTitleSelection {
  const next = validateSelection(sel)
  const cleanPrior = validateSelection(prior)

  // Cap categories
  const nextCats = Object.keys(next)
  const priorCats = Object.keys(cleanPrior)
  const effectiveCatCap = Math.max(priorCats.length, caps.maxCategories)
  if (nextCats.length > effectiveCatCap) {
    const priorSet = new Set(priorCats)
    // Keep prior cats first, then net-new cats in original order, trim to cap.
    const ordered = [
      ...nextCats.filter((c) => priorSet.has(c)),
      ...nextCats.filter((c) => !priorSet.has(c)),
    ]
    const keptCats = new Set(ordered.slice(0, effectiveCatCap))
    for (const c of Object.keys(next)) {
      if (!keptCats.has(c)) delete next[c]
    }
  }

  // Cap total titles
  const priorTitleCount = countTitles(cleanPrior)
  const effectiveTitleCap = Math.max(priorTitleCount, caps.maxTitles)
  let current = countTitles(next)
  if (current > effectiveTitleCap) {
    // Trim titles per category, preserving prior titles first.
    for (const cat of Object.keys(next)) {
      if (current <= effectiveTitleCap) break
      const priorTitlesInCat = new Set((cleanPrior[cat] as string[] | undefined) ?? [])
      const arr = next[cat]
      const priorKept = arr.filter((t) => priorTitlesInCat.has(t))
      const newAdds = arr.filter((t) => !priorTitlesInCat.has(t))
      // Room left in the cap after counting all other cats:
      const otherCount = current - arr.length
      const room = Math.max(0, effectiveTitleCap - otherCount - priorKept.length)
      const newKept = newAdds.slice(0, room)
      next[cat] = [...priorKept, ...newKept]
      current = countTitles(next)
    }
  }

  return next
}

// ─────────────────────────────────────────────────────────────────────
// A-1 baseline (preserved verbatim — no renames, no removals).
//
// ROLE_TAXONOMY_VALUES is the UNION of (all A-1 values) + (all new Phase B
// canonical titles), with duplicates dedup'd. Existing A-1 spellings are
// preserved exactly. 'Legal Operations' and 'Consultant' appear in both
// the A-1 baseline and Phase B canonical titles — each is a single entry.
// ─────────────────────────────────────────────────────────────────────

export const ROLE_TAXONOMY_VALUES = [
  // ─── A-1 baseline (20 values, exact order preserved) ───
  'Executive / C-Suite',
  'Investor / VC',
  'Government / Policy',
  'Finance',
  'Healthcare',
  'Legal',
  'In-house Counsel',
  'Law Firm Attorney',
  'Legal Operations',  // also a Phase B canonical title (Legal); dedup → single entry
  'Compliance',
  'Risk',
  'Privacy',
  'Regulatory Affairs',
  'Government Affairs',
  'Consultant',        // also a Phase B canonical title (Consulting / Advisory); dedup → single entry
  'Legal Tech Founder',
  'Finance Professional',
  'Healthcare Professional',
  'Other',
  'Government / Public Sector',
  // ─── Phase B canonical titles, dedup'd against A-1 ───
  // Legal (6 new; 'Legal Operations' dedup'd against A-1)
  'General Counsel',
  'Chief Legal Officer',
  'In-House Counsel',
  'Deputy General Counsel',
  'Associate General Counsel',
  'Law Firm Partner',
  // Executive / C-Suite (5 new)
  'CEO',
  'Founder',
  'President',
  'COO',
  'Chief Strategy Officer',
  // Finance (5 new)
  'CFO',
  'VP Finance',
  'Controller',
  'Treasurer',
  'Head of FP&A',
  // HR / People (4 new)
  'CHRO',
  'Chief People Officer',
  'Head of Talent',
  'HR Executive',
  // Sales / Revenue (4 new)
  'CRO',
  'VP Sales',
  'Head of Business Development',
  'Partnerships Executive',
  // Marketing (3 new)
  'CMO',
  'VP Marketing',
  'Brand Executive',
  // Operations (2 new)
  'Operations Executive',
  'Transformation Executive',
  // Technology / Cybersecurity (5 new)
  'CTO',
  'CIO',
  'CISO',
  'Technology Executive',
  'Cybersecurity Executive',
  // Government Affairs / Policy (3 new)
  'Government Affairs Executive',
  'Public Policy Executive',
  'Regulatory Affairs Executive',
  // Investor / Private Equity (5 new)
  'Investor',
  'General Partner',
  'Managing Director',
  'Operating Partner',
  'Portfolio Operations Executive',
  // Healthcare (2 new)
  'Healthcare Executive',
  'Life Sciences Executive',
  // Consulting / Advisory (2 new; 'Consultant' dedup'd against A-1)
  'Advisor',
  'Professional Services Executive',
] as const

export type RoleType = (typeof ROLE_TAXONOMY_VALUES)[number]

/**
 * Display-label map. Identity today (value === label everywhere). Kept as a
 * separate map so a future phase can change display strings without
 * touching stored values.
 */
export const ROLE_TAXONOMY_LABELS = Object.fromEntries(
  ROLE_TAXONOMY_VALUES.map((v) => [v, v])
) as Record<RoleType, string>

// ─────────────────────────────────────────────────────────────────────
// A-1 per-surface VIEW_* arrays
//
// After Phase B, the four form components render from ROLE_CATEGORIES
// grouped <optgroup> instead of these flat arrays. These exports are
// preserved verbatim to keep A-1's surface contract intact; a future
// micro-cleanup phase can remove them if no external consumer surfaces.
// ─────────────────────────────────────────────────────────────────────

export const VIEW_ONBOARDING: ReadonlyArray<RoleType> = [
  'Executive / C-Suite',
  'Investor / VC',
  'Government / Policy',
  'Finance',
  'Healthcare',
  'Legal',
]

export const VIEW_PROFILE: ReadonlyArray<RoleType> = [
  'In-house Counsel',
  'Law Firm Attorney',
  'Legal Operations',
  'Compliance',
  'Risk',
  'Privacy',
  'Regulatory Affairs',
  'Government Affairs',
  'Consultant',
  'Legal Tech Founder',
  'Executive / C-Suite',
  'Investor / VC',
  'Government / Policy',
  'Finance Professional',
  'Healthcare Professional',
  'Other',
]

export const VIEW_SETTINGS: ReadonlyArray<RoleType> = [
  'In-house Counsel',
  'Law Firm Attorney',
  'Consultant',
  'Legal Operations',
  'Compliance',
  'Government / Public Sector',
  'Other',
]

export const VIEW_ONBOARDING_ALT: ReadonlyArray<RoleType> = [
  'In-house Counsel',
  'Law Firm Attorney',
  'Consultant',
  'Legal Operations',
  'Compliance',
  'Government / Public Sector',
  'Other',
]
