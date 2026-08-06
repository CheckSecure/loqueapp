import { isPlaceholderCompany } from '@/lib/professionalIdentity'
import { isAmbiguousCompanyName } from '@/lib/company/slug'
import { buildCompanyResolver, resolveCompany } from '@/lib/company/companyResolver'

/**
 * Automatic member → canonical company linking.
 *
 * Resolves a member's FREE-TEXT `profiles.company` to exactly one canonical
 * `companies.id`, reusing the SAME normalization + resolver the CSV importer uses
 * (slug.ts / companyResolver.ts) — no new matching logic, no substring matching.
 *
 * Automatic linking is DELIBERATELY CONSERVATIVE: only an EXACT canonical-name
 * match or a NORMALIZED/registry-alias (explicit approved mapping) links. Fuzzy
 * similarity — trailing-descriptor reduction — is NEVER trusted for auto-linking,
 * even when it yields a single candidate; it is treated as unresolved (clear), so
 * a guessed relationship can never be written. (Admins can still link manually.)
 *
 * The result is a three-way ACTION so callers can distinguish clearing a stale
 * link from failing open:
 *   • set      → one clear canonical match (exact OR registry-canonical alias only)
 *   • clear    → placeholder, ambiguous, fuzzy-only, or no match → company_id MUST become null
 *   • preserve → the companies lookup FAILED → leave company_id untouched (fail open)
 *
 * Guarantees: never creates a company, never substring-matches, never throws, and
 * never blocks a profile save. `profiles.company` (the free-text value) is never
 * touched by this module — only `company_id`.
 */

// Auto-linking only ever SETs on a trusted (non-fuzzy) match.
export type CanonicalLinkConfidence = 'exact' | 'canonical'

export type CanonicalLinkAction =
  | { action: 'set'; companyId: string; confidence: CanonicalLinkConfidence }
  | { action: 'clear' }
  | { action: 'preserve' }

// Minimal structural shape so both the user-scoped and service-role clients pass.
type CompaniesDb = { from: (table: string) => any }

export async function resolveCanonicalCompanyLink(
  db: CompaniesDb,
  companyName: string | null | undefined,
): Promise<CanonicalLinkAction> {
  const name = (companyName || '').trim()
  // No employer, a placeholder identity (Independent / Stealth / Retired / …), or a
  // known-ambiguous short alias (BD / TKO / Wonder / …) → never guess. Clear any
  // stale link; these must not carry a canonical company_id.
  if (!name) return { action: 'clear' }
  if (isPlaceholderCompany(name)) return { action: 'clear' }
  if (isAmbiguousCompanyName(name)) return { action: 'clear' }

  // Load the candidate set (every canonical company). Ambiguity detection needs the
  // WHOLE set, so we can't shortcut to a single-slug lookup. Fail OPEN on any error.
  let rows: Array<{ id: string; name: string | null; slug: string | null }> | null = null
  try {
    const res = await db.from('companies').select('id, name, slug')
    if (res?.error) return { action: 'preserve' }
    rows = (res?.data as any[]) ?? null
  } catch {
    return { action: 'preserve' }
  }
  if (!rows) return { action: 'preserve' }

  const idBySlug = new Map<string, string>()
  const candidates = rows.map((c) => {
    if (c.slug && !idBySlug.has(c.slug)) idBySlug.set(c.slug, c.id)
    return { slug: c.slug ?? '', name: c.name }
  })

  // resolveCompany enforces single-candidate uniqueness (equality, not substring) and
  // returns null on ambiguity → a genuinely unresolved company → clear.
  const match = resolveCompany(name, buildCompanyResolver(candidates))
  if (!match) return { action: 'clear' }
  // FUZZY similarity is NOT trusted for automatic linking — even a unique fuzzy
  // candidate is treated as unresolved (clear), never a guessed link. Only exact
  // and registry-canonical (explicit approved alias) matches auto-link.
  // (Future: an admin-review log could capture the rejected fuzzy candidate here.)
  if (match.confidence !== 'exact' && match.confidence !== 'canonical') return { action: 'clear' }
  const companyId = idBySlug.get(match.slug)
  if (!companyId) return { action: 'clear' }
  return { action: 'set', companyId, confidence: match.confidence }
}

/**
 * Spec-named convenience: the canonical `companies.id` for a free-text company, or
 * `null` when there is not exactly one confident match (placeholder / ambiguous /
 * none / lookup failure). Prefer `resolveCanonicalCompanyLink` in write paths so a
 * lookup failure (preserve) is not confused with "no match" (clear).
 */
export async function resolveCanonicalCompanyId(
  db: CompaniesDb,
  companyName: string | null | undefined,
): Promise<string | null> {
  const link = await resolveCanonicalCompanyLink(db, companyName)
  return link.action === 'set' ? link.companyId : null
}
