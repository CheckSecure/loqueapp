import { companySlug, isLinkableCompany } from '@/lib/company/slug'
import { isEnrichmentEnabled, resolveDomainByName, enrichByDomain, composeDescription } from '@/lib/company/provider'

/** Failed/incomplete enrichments become eligible to retry after this interval. */
export const ENRICH_RETRY_MS = 7 * 24 * 60 * 60 * 1000

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

export type EnrichResult = { status: 'disabled' | 'skipped' | 'enriched' | 'not_found' | 'failed' | 'error' }

/**
 * Enrich one company row via the provider. Safe to call on first page view and
 * from the reconciliation cron. Guarantees:
 *   - never runs when the provider key is unset (disabled),
 *   - never touches admin_edited rows,
 *   - never re-charges an already-enriched row,
 *   - never double-charges under concurrency (an atomic conditional claim acts
 *     as the lock),
 *   - only retries failed/not_found after ENRICH_RETRY_MS,
 *   - always leaves a terminal status (never stuck in_progress on timeout).
 */
export async function enrichCompany(admin: any, slug: string, name: string): Promise<EnrichResult> {
  if (!isEnrichmentEnabled()) return { status: 'disabled' }
  if (!slug || !name?.trim()) return { status: 'skipped' }

  const nowIso = new Date().toISOString()
  const retryBefore = new Date(Date.now() - ENRICH_RETRY_MS).toISOString()

  // Atomic claim = concurrency lock + dedup + retry gate. Only rows that are
  // eligible (not admin_edited, not already enriched, and either never tried,
  // previously failed/not_found past the retry window, or a stale in_progress)
  // are claimed. If 0 rows come back, someone else owns it or it's done → skip.
  const claim = await admin
    .from('companies')
    .update({ enrichment_status: 'in_progress', enrichment_attempted_at: nowIso })
    .eq('slug', slug)
    .eq('admin_edited', false)
    .or(`enrichment_status.is.null,and(enrichment_status.in.(failed,not_found),enrichment_attempted_at.lt.${retryBefore}),and(enrichment_status.eq.in_progress,enrichment_attempted_at.lt.${retryBefore})`)
    .select('slug')
  if (claim.error) return { status: 'error' }
  if (!claim.data || claim.data.length === 0) return { status: 'skipped' }

  const finalize = (patch: Record<string, unknown>) =>
    admin.from('companies').update({ ...patch, updated_at: new Date().toISOString() }).eq('slug', slug).eq('admin_edited', false)

  // Step 1: name → domain
  const dr = await resolveDomainByName(name)
  if (!dr.domain) {
    await finalize({ enrichment_status: dr.error ? 'failed' : 'not_found', enrichment_error: dr.error ?? null })
    return { status: dr.error ? 'failed' : 'not_found' }
  }

  // Step 2: domain → structured fields
  const er = await enrichByDomain(dr.domain)
  if (er.notFound) { await finalize({ enrichment_status: 'not_found', enrichment_error: null }); return { status: 'not_found' } }
  if (er.error || !er.fields) { await finalize({ enrichment_status: 'failed', enrichment_error: er.error ?? 'no_fields' }); return { status: 'failed' } }

  const f = er.fields
  await finalize({
    name: f.name || name,
    website: f.website,
    logo_url: f.logo_url,
    industry: f.industry,
    headquarters: f.headquarters,
    company_size: f.company_size,
    description: composeDescription(f, f.name || name),
    enrichment_status: 'enriched',
    enrichment_source: 'thecompaniesapi',
    enrichment_error: null,
    enriched_at: new Date().toISOString(),
  })
  return { status: 'enriched' }
}
