import { ensureCompanyRecord, ENRICH_RETRY_MS } from '@/lib/company/enrich'
import { discoveryProvider } from './discovery'
import { extractMetadata } from './extract'
import { downloadAndStoreLogo } from './logo'
import { fetchText } from './http'
import type { EnrichResult } from './types'

/**
 * Run the full self-hosted enrichment for one company and persist the result.
 *
 * Pipeline: ensure the row exists → atomically claim it (concurrency lock + retry
 * gate) → discover the official website → fetch + extract homepage metadata →
 * download the logo into our Storage bucket → persist. Guarantees preserved from
 * the previous implementation:
 *   - never touches admin_edited rows,
 *   - never re-runs an already-enriched row (unless `force`),
 *   - never double-runs under concurrency (the atomic claim is the lock),
 *   - only retries failed/not_found after ENRICH_RETRY_MS,
 *   - always leaves a terminal status (never stuck in_progress on a fault),
 *   - only writes fields it actually determined (nulls never wipe prior values).
 *
 * No third-party enrichment API and no API key: works out of the box.
 */
export async function runEnrichment(
  admin: any,
  slug: string,
  name: string,
  opts: { force?: boolean } = {},
): Promise<EnrichResult> {
  if (!slug || !name?.trim()) return { status: 'skipped' }
  const force = !!opts.force

  await ensureCompanyRecord(admin, slug, name)

  const nowIso = new Date().toISOString()
  const retryBefore = new Date(Date.now() - ENRICH_RETRY_MS).toISOString()

  // Atomic claim = lock + dedup + retry gate. `force` (manual refresh) bypasses
  // the eligibility filter but still refuses to touch admin_edited rows.
  let claimQ = admin
    .from('companies')
    .update({ enrichment_status: 'in_progress', enrichment_attempted_at: nowIso })
    .eq('slug', slug)
    .eq('admin_edited', false)
  if (!force) {
    claimQ = claimQ.or(
      `enrichment_status.is.null,and(enrichment_status.in.(failed,not_found),enrichment_attempted_at.lt.${retryBefore}),and(enrichment_status.eq.in_progress,enrichment_attempted_at.lt.${retryBefore})`,
    )
  }
  const claim = await claimQ.select('slug')
  if (claim.error) {
    console.error(`[company-enrich] claim error slug=${slug}: ${claim.error.message}`)
    return { status: 'error' }
  }
  if (!claim.data || claim.data.length === 0) return { status: 'skipped' }

  const finalize = (patch: Record<string, unknown>) =>
    admin.from('companies').update({ ...patch, updated_at: new Date().toISOString() }).eq('slug', slug).eq('admin_edited', false)

  console.log(JSON.stringify({ event: 'company_enrich_start', slug, name, force }))

  try {
    // 1) Discover the official website.
    const disc = await discoveryProvider.discover(name)
    console.log(JSON.stringify({ event: 'company_enrich_discovery', slug, website: disc.website, via: disc.via }))
    if (!disc.website) {
      await finalize({ enrichment_status: 'not_found', enrichment_error: null, enrichment_source: 'self:homepage' })
      return { status: 'not_found' }
    }

    // 2) Fetch the homepage and extract structured metadata.
    const page = await fetchText(disc.website, 7000)
    const { metadata, logoCandidates } = extractMetadata(page.text || '', page.url || disc.website)
    console.log(JSON.stringify({
      event: 'company_enrich_extracted', slug,
      hasDescription: !!metadata.description, hasHq: !!metadata.headquarters, logoCandidates: logoCandidates.length,
    }))

    // 3) Download the best logo into our own Storage bucket (never hotlink).
    const storedLogo = await downloadAndStoreLogo(admin, slug, logoCandidates)
    console.log(JSON.stringify({ event: 'company_enrich_logo', slug, stored: !!storedLogo }))

    // 4) Persist — only fields we actually determined (COALESCE semantics: a null
    //    result never overwrites a value from a prior run or an admin edit).
    const patch: Record<string, unknown> = {
      enrichment_status: 'enriched',
      enrichment_source: 'self:homepage',
      enrichment_error: null,
      enriched_at: new Date().toISOString(),
    }
    if (metadata.website) patch.website = metadata.website
    if (metadata.description) patch.description = metadata.description
    if (metadata.headquarters) patch.headquarters = metadata.headquarters
    if (metadata.industry) patch.industry = metadata.industry
    if (storedLogo) patch.logo_url = storedLogo

    const upd = await finalize(patch)
    if (upd.error) {
      console.error(`[company-enrich] finalize error slug=${slug}: ${upd.error.message}`)
      return { status: 'failed' }
    }
    console.log(JSON.stringify({ event: 'company_enrich_done', slug, status: 'enriched', via: disc.via, logo: !!storedLogo }))
    return { status: 'enriched', website: metadata.website, logoStored: !!storedLogo, fields: metadata }
  } catch (e: any) {
    const msg = (e?.message || 'enrich_error').slice(0, 300)
    console.error(`[company-enrich] threw slug=${slug}: ${msg}`)
    await finalize({ enrichment_status: 'failed', enrichment_error: msg, enrichment_source: 'self:homepage' }).catch(() => {})
    return { status: 'failed' }
  }
}
