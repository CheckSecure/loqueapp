import { companySlug, isLinkableCompany } from '@/lib/company/slug'

/** Failed/incomplete enrichments become eligible to retry after this interval. */
export const ENRICH_RETRY_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Company self-population helpers.
 *
 * The set of companies Andrel cares about is DERIVED from members' `company`
 * fields (no manual list to maintain). `computeNetworkCompanies` produces that
 * set, deduped by normalized slug. Records are materialized lazily (first page
 * view) and enriched by the self-hosted pipeline in lib/company/enrichment/ —
 * always skipping `admin_edited` rows so a human's edits are never overwritten.
 *
 * NOTE: the enrichment orchestrator lives in `enrichment/run.ts` and imports
 * `ensureCompanyRecord` + `ENRICH_RETRY_MS` from here. Keep this module free of
 * back-imports from `enrichment/` to avoid a cycle.
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
 * Materialize a canonical company record (slug + name). Called by the enrichment
 * orchestrator, which is triggered the moment a company first enters the network
 * (a member saves their profile — see scheduleEnrichment); the cron is only
 * reconciliation/backfill.
 *
 * `ignoreDuplicates` + no updated fields on conflict means this NEVER overwrites
 * an existing row, so admin_edited rows (and any prior enrichment) are always
 * preserved. Non-fatal and deploy-safe: if the table isn't applied yet, or the
 * write fails, callers still proceed. runEnrichment then fills the richer fields
 * (logo/description/website/HQ), always updating ONLY admin_edited = false rows.
 */
export async function ensureCompanyRecord(admin: any, slug: string, name: string): Promise<void> {
  if (!slug || !name?.trim()) return
  try {
    const { error } = await admin.from('companies').upsert(
      { slug, name: name.trim(), enrichment_source: 'auto:on_create' },
      { onConflict: 'slug', ignoreDuplicates: true },
    )
    if (error && !/PGRST205|schema cache|does not exist/i.test(`${error.message} ${error.code}`)) {
      console.error('[company] ensureCompanyRecord failed:', error.message)
    }
  } catch {
    /* never block a page render on record materialization */
  }
}

