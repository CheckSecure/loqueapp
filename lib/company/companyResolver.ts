import { companySlug, resolveCanonicalCompany, normalizeCompanyName } from '@/lib/company/slug'

/**
 * Company resolution for the CSV enrichment importer.
 *
 * The importer must map an arbitrary CSV `company_name` onto one of the companies
 * that actually exist in the network (materialized `companies` rows + member-derived
 * network companies). Exact slug equality alone is too strict: the CSV often carries
 * the FULL official name ("Neurocrine Biosciences") while a member typed a short form
 * ("Neurocrine"), and companySlug only collapses legal-form suffixes + registry
 * aliases — not descriptive tails like "Biosciences" / "Technologies" / "Group".
 *
 * Resolution is attempted in confidence order, most-trustworthy first:
 *   A. exact     — the plain normalized slug (no registry) equals a candidate slug.
 *   B. canonical — a registry alias (resolveCanonicalCompany) maps the name onto a
 *                  candidate slug it wouldn't otherwise reach ("DWT" → davis-wright-tremaine).
 *   C. fuzzy     — an AGGRESSIVE trailing-suffix reduction (legal + descriptive words)
 *                  equals exactly ONE candidate's reduced key. Uniqueness is required, so
 *                  an ambiguous key (two candidates, e.g. two "GPS Law …" firms) stays
 *                  unresolved, and equality (not edit-distance) means "Wonder" never
 *                  drifts onto "Wonderlic".
 *
 * This module is pure and only READS existing normalization (slug.ts / registry) — it
 * never mutates companies, profiles, or the enrichment pipeline.
 */

export type ResolveConfidence = 'exact' | 'canonical' | 'fuzzy'

export interface ResolvableCompany {
  slug: string
  name?: string | null
}

export interface CompanyResolution {
  slug: string
  confidence: ResolveConfidence
  candidate: ResolvableCompany
}

// Trailing tokens the FUZZY layer strips ON TOP of normalizeCompanyName's legal
// suffixes: descriptive tails that don't change company identity in this network.
// Only removed when trailing, and never down to an empty string (>=1 token kept).
const FUZZY_TRAILING = new Set([
  // legal forms not already covered by normalizeCompanyName (pllc/pc), plus repeats
  'llc', 'inc', 'incorporated', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company',
  'llp', 'lp', 'plc', 'pllc', 'pc', 'gmbh', 'sa', 'ag', 'pty', 'pte', 'bv', 'nv',
  // descriptive tails
  'technologies', 'technology', 'tech', 'holdings', 'holding', 'group', 'solutions',
  'labs', 'laboratories', 'biosciences', 'bioscience', 'pharmaceuticals', 'pharma',
  'education', 'systems', 'industries', 'international', 'worldwide', 'global',
  'ventures', 'capital', 'partners', 'associates', 'services', 'enterprises',
  'networks', 'communications', 'brands', 'companies', 'digital', 'media',
])

const FUZZY_FILLER = new Set(['and', 'the', 'of', 'for'])

/**
 * Aggressive normalization for the fuzzy layer: start from the canonical comparison
 * form (lowercase, punctuation removed, legal suffixes + dotted acronyms handled),
 * then strip trailing descriptive/legal tails. Always keeps at least one token.
 */
export function fuzzyKey(raw?: string | null): string {
  const base = normalizeCompanyName(raw)
  if (!base) return ''
  const tokens = base.split(' ')
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]
    if (FUZZY_TRAILING.has(last) || FUZZY_FILLER.has(last)) tokens.pop()
    else break
  }
  return tokens.join(' ')
}

export interface CompanyResolver {
  bySlug: Map<string, ResolvableCompany>
  /** fuzzyKey → candidate slugs sharing it (ambiguous when length > 1). */
  byFuzzy: Map<string, string[]>
}

/** Index a candidate set (existing rows + network companies) for resolution. */
export function buildCompanyResolver(candidates: ResolvableCompany[]): CompanyResolver {
  const bySlug = new Map<string, ResolvableCompany>()
  const byFuzzy = new Map<string, string[]>()
  for (const c of candidates) {
    if (!c.slug) continue
    if (!bySlug.has(c.slug)) bySlug.set(c.slug, c)
    // Fuzzy index is keyed off the candidate's human name (member text / display name),
    // falling back to the slug words when a name is absent.
    const fk = fuzzyKey(c.name ?? c.slug.replace(/-/g, ' '))
    if (fk.length >= 3) {
      const arr = byFuzzy.get(fk) ?? []
      if (!arr.includes(c.slug)) arr.push(c.slug)
      byFuzzy.set(fk, arr)
    }
  }
  return { bySlug, byFuzzy }
}

/**
 * Resolve a CSV company name to a known candidate, or null if it can't be matched
 * with high confidence. See module doc for the A→B→C order.
 */
export function resolveCompany(rawName: string, r: CompanyResolver): CompanyResolution | null {
  // A. Exact — plain normalized slug (no registry aliasing needed).
  const rawSlug = normalizeCompanyName(rawName).replace(/\s+/g, '-')
  if (rawSlug && r.bySlug.has(rawSlug)) {
    return { slug: rawSlug, confidence: 'exact', candidate: r.bySlug.get(rawSlug)! }
  }

  // B. Canonical — a registry alias maps this name onto a candidate it wouldn't
  //    otherwise reach (e.g. "DWT" → davis-wright-tremaine).
  const canonSlug = companySlug(rawName)
  if (canonSlug && canonSlug !== rawSlug && r.bySlug.has(canonSlug)) {
    return { slug: canonSlug, confidence: 'canonical', candidate: r.bySlug.get(canonSlug)! }
  }

  // C. Fuzzy — aggressive trailing-suffix reduction, UNIQUE candidate only.
  const fk = fuzzyKey(rawName)
  if (fk.length >= 3) {
    const matches = r.byFuzzy.get(fk)
    if (matches && matches.length === 1) {
      return { slug: matches[0], confidence: 'fuzzy', candidate: r.bySlug.get(matches[0])! }
    }
  }

  return null
}

export interface NearestCandidate { company_name: string; slug: string; score: number }

/**
 * DIAGNOSTIC ONLY — not part of matching. For an unmatched name, surface the
 * candidates that come closest, so an admin can see WHY the match failed (a shared
 * word, an aggressive-key prefix overlap, or nothing at all → the company just
 * isn't in the set). Ranks by shared normalized tokens, with an aggressive-key
 * prefix affinity as a tiebreaker. Never influences resolveCompany.
 */
export function nearestCandidates(rawName: string, r: CompanyResolver, limit = 3): NearestCandidate[] {
  const csvTokens = new Set(normalizeCompanyName(rawName).split(' ').filter(Boolean))
  const csvKey = fuzzyKey(rawName)
  const scored: NearestCandidate[] = []
  for (const c of r.bySlug.values()) {
    const name = c.name ?? c.slug.replace(/-/g, ' ')
    const tokens = normalizeCompanyName(name).split(' ').filter(Boolean)
    let shared = 0
    for (const t of tokens) if (csvTokens.has(t)) shared++
    const key = fuzzyKey(name)
    const prefix = csvKey && key && (csvKey.startsWith(key) || key.startsWith(csvKey)) ? 1 : 0
    const score = shared * 2 + prefix
    if (score > 0) scored.push({ company_name: name, slug: c.slug, score })
  }
  scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
  return scored.slice(0, limit)
}
