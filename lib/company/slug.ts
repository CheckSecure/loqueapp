import { isPlaceholderCompany } from '@/lib/professionalIdentity'

/**
 * Deterministic company → slug normalization so formatting variants collapse to
 * one Company Page: "Google LLC", "Google, Inc.", "Google" → "google".
 *
 * Strategy: lowercase, drop punctuation, strip trailing legal-form suffixes
 * (LLC / Inc / Ltd / Corp / Co / GmbH / …), collapse whitespace, hyphenate.
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

/** Canonical comparison form: lowercase, punctuation→space, legal suffixes removed. */
export function normalizeCompanyName(raw?: string | null): string {
  if (!raw) return ''
  const cleaned = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  const tokens = cleaned.split(' ')
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop()
  return tokens.join(' ')
}

/** URL slug for /company/[slug]. Empty string when there's nothing to slug. */
export function companySlug(raw?: string | null): string {
  return normalizeCompanyName(raw).replace(/\s+/g, '-')
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
