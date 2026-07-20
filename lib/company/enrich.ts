import { companySlug, isLinkableCompany } from '@/lib/company/slug'

/**
 * Company self-population helpers.
 *
 * The set of companies Andrel cares about is DERIVED from members' `company`
 * fields (no manual list to maintain). `computeNetworkCompanies` produces that
 * set, deduped by normalized slug. The enrichment cron materializes a canonical
 * record for each so pages accrue rows automatically, and a future enrichment
 * provider fills the richer fields — always skipping `admin_edited` rows so a
 * human's edits are never overwritten.
 */

export type NetworkCompany = { slug: string; name: string; memberCount: number }

/** Distinct real companies across member profiles, keyed by normalized slug. */
export function computeNetworkCompanies(
  profiles: Array<{ company: string | null }> | null | undefined,
): NetworkCompany[] {
  const bySlug = new Map<string, NetworkCompany>()
  for (const p of profiles ?? []) {
    if (!isLinkableCompany(p.company)) continue
    const slug = companySlug(p.company)
    const existing = bySlug.get(slug) || { slug, name: (p.company || '').trim(), memberCount: 0 }
    existing.memberCount++
    bySlug.set(slug, existing)
  }
  return Array.from(bySlug.values()).sort(
    (a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name),
  )
}
