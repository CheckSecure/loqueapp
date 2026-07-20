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

/**
 * Materialize a canonical company record the moment a company is first
 * encountered (e.g. its page is first requested). This is the PRIMARY way rows
 * are created — the cron is only reconciliation/backfill.
 *
 * `ignoreDuplicates` + no updated fields on conflict means this NEVER overwrites
 * an existing row, so admin_edited rows (and any prior enrichment) are always
 * preserved. Non-fatal and deploy-safe: if the table isn't applied yet, or the
 * write fails, the page still renders from derived data.
 *
 * The richer-metadata provider (logo/industry/HQ/size/description) plugs in here
 * later and must likewise update ONLY admin_edited = false rows.
 */
export async function ensureCompanyRecord(admin: any, slug: string, name: string): Promise<void> {
  if (!slug || !name?.trim()) return
  try {
    const { error } = await admin.from('companies').upsert(
      { slug, name: name.trim(), enrichment_source: 'auto:on_view', enriched_at: new Date().toISOString() },
      { onConflict: 'slug', ignoreDuplicates: true },
    )
    if (error && !/PGRST205|schema cache|does not exist/i.test(`${error.message} ${error.code}`)) {
      console.error('[company] ensureCompanyRecord failed:', error.message)
    }
  } catch {
    /* never block a page render on record materialization */
  }
}
