import { isPlaceholderCompany } from '@/lib/professionalIdentity'
import { COMPANY_REGISTRY, type CanonicalCompany } from '@/lib/company/registry'

/**
 * Deterministic company → slug normalization so formatting variants collapse to
 * one Company Page: "Google LLC", "Google, Inc.", "Google" → "google".
 *
 * Strategy: lowercase, drop punctuation, collapse dotted acronyms ("L.L.P." →
 * "llp"), strip trailing legal-form suffixes (LLC / Inc / Ltd / Corp / …),
 * collapse whitespace, hyphenate. Then a curated alias registry (registry.ts)
 * maps known variants/acronyms ("DWT", "BD", "Hughes Hubbard", "Dentsu/Merkle")
 * to a single canonical company, so they all resolve to the same page.
 * Kept pure and dependency-light so it is safe in both client and server
 * bundles (CompanyLink uses it client-side; the company page uses it server-side).
 */

// Legal-form suffix tokens stripped only when they are the trailing word(s).
// Deliberately excludes meaningful words like "group"/"holdings"/"partners".
const LEGAL_SUFFIXES = new Set([
  'llc', 'inc', 'incorporated', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'gmbh', 'llp', 'lp', 'plc', 'sa', 'ag', 'pty', 'pte',
  'bv', 'nv', 'srl', 'ab', 'oy', 'as', 'kk', 'spa',
])

// Trailing filler stripped after legal suffixes so e.g. "Becton, Dickinson and
// Company" → "becton dickinson" (not "…-and"). Only removed when trailing.
const TRAILING_FILLER = new Set(['and', 'the', 'of', 'for'])

/** Canonical comparison form: lowercase, punctuation→space, legal suffixes removed. */
export function normalizeCompanyName(raw?: string | null): string {
  if (!raw) return ''
  let cleaned = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  // Collapse spaced single-letter runs from dotted acronyms so legal suffixes
  // are recognized: "L.L.P." → "l l p" → "llp"; "L.L.C." → "llc"; "J.P." → "jp".
  cleaned = cleaned.replace(/\b([a-z]) (?=[a-z]\b)/g, '$1')
  const tokens = cleaned.split(' ')
  while (tokens.length > 1) {
    const last = tokens[tokens.length - 1]
    if (LEGAL_SUFFIXES.has(last) || TRAILING_FILLER.has(last)) tokens.pop()
    else break
  }
  return tokens.join(' ')
}

/**
 * Registry lookup index: every canonical name + alias, normalized, → its
 * canonical company. Built once at module load.
 */
const REGISTRY_INDEX: Map<string, CanonicalCompany> = (() => {
  const index = new Map<string, CanonicalCompany>()
  for (const company of COMPANY_REGISTRY) {
    for (const variant of [company.name, ...company.aliases]) {
      const key = normalizeCompanyName(variant)
      if (key && !index.has(key)) index.set(key, company)
    }
  }
  return index
})()

/**
 * Resolve a free-text company name to its canonical registry entry (canonical
 * name + authoritative domain), or null if it isn't a known alias. Used by the
 * enrichment pipeline for domain-first discovery and by companySlug for
 * canonical-page collapsing.
 */
export function resolveCanonicalCompany(raw?: string | null): CanonicalCompany | null {
  const key = normalizeCompanyName(raw)
  if (!key) return null
  return REGISTRY_INDEX.get(key) ?? null
}

/**
 * URL slug for /company/[slug]. Empty string when there's nothing to slug.
 * Alias-aware: a known variant resolves to its CANONICAL company's slug, so
 * "Hughes Hubbard", "Hughes Hubbard & Reed LLP", and "DWT" all land on the one
 * correct page — without touching the member's stored company text.
 */
export function companySlug(raw?: string | null): string {
  const canonical = resolveCanonicalCompany(raw)
  const base = canonical ? canonical.name : raw
  return normalizeCompanyName(base).replace(/\s+/g, '-')
}

/**
 * True when `raw` resolves via a short/acronym alias flagged ambiguous (BD, TKO,
 * Wonder, Merkle, Caribou, …). The mapping still applies (current members are
 * known-correct), but callers/migrations should route these through human review
 * rather than trusting them silently for arbitrary future free-text.
 */
const AMBIGUOUS_KEYS: Set<string> = (() => {
  const set = new Set<string>()
  for (const company of COMPANY_REGISTRY) {
    for (const alias of company.ambiguousAliases ?? []) {
      const key = normalizeCompanyName(alias)
      if (key) set.add(key)
    }
  }
  return set
})()

export function isAmbiguousCompanyName(raw?: string | null): boolean {
  const key = normalizeCompanyName(raw)
  return key ? AMBIGUOUS_KEYS.has(key) : false
}

/**
 * LEGACY slug (pre-registry, pre-dotted-acronym, pre-trailing-filler) — used
 * only to build old→canonical redirects so bookmarked/cached URLs like
 * /company/bd, /company/dentsu-merkle, /company/baker-botts-l-l-p keep working.
 */
function legacyNormalize(raw?: string | null): string {
  if (!raw) return ''
  const cleaned = raw.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  const tokens = cleaned.split(' ')
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop()
  return tokens.join(' ')
}
export function legacyCompanySlug(raw?: string | null): string {
  return legacyNormalize(raw).replace(/\s+/g, '-')
}

// old slug → canonical slug, auto-derived from every registry name/alias whose
// legacy slug differs from its canonical slug. Extends automatically as the
// registry grows — no hand-maintained redirect list.
const LEGACY_REDIRECTS: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const company of COMPANY_REGISTRY) {
    const canonical = companySlug(company.name)
    for (const variant of [company.name, ...company.aliases]) {
      const legacy = legacyCompanySlug(variant)
      if (legacy && legacy !== canonical && !map.has(legacy)) map.set(legacy, canonical)
    }
  }
  return map
})()

/** Canonical slug an old/legacy company slug should redirect to, or null. */
export function resolveLegacySlug(oldSlug?: string | null): string | null {
  if (!oldSlug) return null
  const target = LEGACY_REDIRECTS.get(oldSlug)
  return target && target !== oldSlug ? target : null
}

/**
 * A company name is linkable only when it slugs to something AND is not a
 * placeholder ("Independent", "Confidential", "Stealth", …) — placeholders
 * describe a situation, not a company, so they never get a page.
 */
export function isLinkableCompany(raw?: string | null): boolean {
  return companySlug(raw).length > 0 && !isPlaceholderCompany(raw)
}

/** Human-readable fallback name derived from a slug ("foo-bar" → "Foo Bar"). */
export function titleCaseSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** Up-to-two-letter initials for the fallback logo avatar. */
export function companyInitials(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  const initials = parts.slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('')
  return initials || '—'
}
