import { ensureCompanyRecord, ENRICH_RETRY_MS } from '@/lib/company/enrich'
import { resolveCanonicalCompany } from '@/lib/company/slug'
import { getCompanyMetadata } from '@/lib/company/metadata'
import { discoveryProvider } from './discovery'
import { extractMetadata } from './extract'
import { downloadAndStoreLogo } from './logo'
import { fetchText } from './http'
import type { EnrichResult, EnrichStages } from './types'

/** True for a usable (non-empty) persisted value. */
const has = (v: unknown): boolean => (typeof v === 'string' ? v.trim().length > 0 : v != null)

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
    // `partial` is retry-eligible too: a later run on a better network may fill
    // the metadata a blocked homepage denied the first time.
    claimQ = claimQ.or(
      `enrichment_status.is.null,and(enrichment_status.in.(failed,not_found,partial),enrichment_attempted_at.lt.${retryBefore}),and(enrichment_status.eq.in_progress,enrichment_attempted_at.lt.${retryBefore})`,
    )
  }
  const claim = await claimQ.select('slug')
  if (claim.error) {
    console.error(`[company-enrich] claim error slug=${slug}: ${claim.error.message}`)
    return { status: 'error' }
  }
  if (!claim.data || claim.data.length === 0) return { status: 'skipped' }

  // Current values, for precedence (existing non-null is preserved over weaker
  // extracted/registry data). admin_edited rows never reach here — the claim and
  // finalize both filter them out.
  const cur = (await admin.from('companies')
    .select('name, website, description, logo_url, headquarters, industry')
    .eq('slug', slug).maybeSingle()).data || {}
  const canonical = resolveCanonicalCompany(name)
  // Curated fallback layer (DB-backed, admin-editable) — lowest precedence.
  const meta = await getCompanyMetadata(admin, slug)

  const finalize = (patch: Record<string, unknown>) =>
    admin.from('companies').update({ ...patch, updated_at: new Date().toISOString() }).eq('slug', slug).eq('admin_edited', false)

  console.log(JSON.stringify({ event: 'company_enrich_start', slug, name, force }))

  try {
    // 1) Discover the official website.
    const disc = await discoveryProvider.discover(name)
    const registryResolved = disc.via === 'registry' || !!canonical
    console.log(JSON.stringify({ event: 'company_enrich_discovery', slug, website: disc.website, via: disc.via, registry: registryResolved }))

    // Only genuinely-unknown companies (no registry entry, no guessable domain)
    // become not_found. A registry company always has an authoritative website.
    if (!disc.website && !canonical?.domain) {
      await finalize({ enrichment_status: 'not_found', enrichment_error: null, enrichment_source: 'discovery' })
      return { status: 'not_found', stages: { identity: 'unresolved', website: false, description: 'none', logo: 'none' } }
    }
    const website = canonical?.domain ? `https://${canonical.domain}` : disc.website!

    // 2) Fetch the homepage and extract structured metadata (may fail: 403/timeout/blocked).
    const page = await fetchText(website, 7000)
    const { metadata, logoCandidates } = extractMetadata(page.text || '', page.url || website)
    const storedLogo = await downloadAndStoreLogo(admin, slug, logoCandidates)
    const scrapedOk = page.ok && (has(metadata.description) || has(metadata.headquarters) || !!storedLogo)
    console.log(JSON.stringify({ event: 'company_enrich_extracted', slug, httpOk: page.ok, scrapedOk, hasDescription: has(metadata.description), logo: !!storedLogo }))

    // 3) Persist with precedence per field:
    //    admin override (already filtered) > existing companies value >
    //    scraped homepage metadata > company_metadata fallback > null.
    //    Identity (canonical name + authoritative website) comes from the registry.
    const patch: Record<string, unknown> = { enrichment_error: null, enriched_at: new Date().toISOString() }

    if (canonical?.name) patch.name = canonical.name                    // authoritative identity
    if (registryResolved) patch.website = website                       // authoritative domain
    else if (!has(cur.website) && has(metadata.website)) patch.website = metadata.website

    let descriptionStage: EnrichStages['description'] = 'none'
    if (has(cur.description)) descriptionStage = 'existing'
    else if (has(metadata.description)) { patch.description = metadata.description; descriptionStage = 'scraped' }
    else if (has(meta.description)) { patch.description = meta.description; descriptionStage = 'fallback' }

    let logoStage: EnrichStages['logo'] = 'none'
    if (has(cur.logo_url)) logoStage = 'existing'
    else if (storedLogo) { patch.logo_url = storedLogo; logoStage = 'scraped' }
    else if (has(meta.logo_url)) { patch.logo_url = meta.logo_url; logoStage = 'fallback' }

    if (!has(cur.headquarters)) {
      const h = has(metadata.headquarters) ? metadata.headquarters : (has(meta.headquarters) ? meta.headquarters : undefined)
      if (has(h)) patch.headquarters = h
    }
    if (!has(cur.industry)) {
      const i = has(metadata.industry) ? metadata.industry : (has(meta.industry) ? meta.industry : undefined)
      if (has(i)) patch.industry = i
    }

    // Registry/search identity resolved but homepage metadata unavailable →
    // `partial` (never blank, never a false `not_found`); full scrape → `enriched`.
    const status: EnrichResult['status'] = scrapedOk ? 'enriched' : 'partial'
    patch.enrichment_status = status
    patch.enrichment_source = disc.via === 'registry' ? (scrapedOk ? 'registry:homepage' : 'registry')
      : disc.via === 'search' ? (scrapedOk ? 'search:homepage' : 'search') : 'self:homepage'

    const stages: EnrichStages = {
      identity: registryResolved ? 'registry' : (disc.via === 'search' ? 'search' : 'unresolved'),
      website: has(patch.website) || has(cur.website),
      description: descriptionStage,
      logo: logoStage,
    }

    const upd = await finalize(patch)
    if (upd.error) {
      console.error(`[company-enrich] finalize error slug=${slug}: ${upd.error.message}`)
      return { status: 'failed', stages }
    }
    console.log(JSON.stringify({ event: 'company_enrich_done', slug, status, via: disc.via, stages }))
    return { status, website: (patch.website as string) ?? cur.website ?? null, logoStored: logoStage === 'scraped', fields: metadata, stages }
  } catch (e: any) {
    const msg = (e?.message || 'enrich_error').slice(0, 300)
    console.error(`[company-enrich] threw slug=${slug}: ${msg}`)
    // A registry company still gets its authoritative identity (name + website)
    // on fault — never blank, never a false not_found.
    const recover: Record<string, unknown> = { enrichment_error: msg, enriched_at: new Date().toISOString() }
    if (canonical?.domain) {
      recover.enrichment_status = 'partial'
      recover.enrichment_source = 'registry'
      recover.name = canonical.name
      recover.website = `https://${canonical.domain}`
      // Apply the curated fallback layer even on fault, so the page isn't bare.
      if (!has(cur.description) && has(meta.description)) recover.description = meta.description
      if (!has(cur.logo_url) && has(meta.logo_url)) recover.logo_url = meta.logo_url
      if (!has(cur.headquarters) && has(meta.headquarters)) recover.headquarters = meta.headquarters
      if (!has(cur.industry) && has(meta.industry)) recover.industry = meta.industry
    } else {
      recover.enrichment_status = 'failed'
      recover.enrichment_source = 'self:homepage'
    }
    await finalize(recover).catch(() => {})
    const stages: EnrichStages = {
      identity: canonical?.domain ? 'registry' : 'unresolved',
      website: !!canonical?.domain || has(cur.website),
      description: has(cur.description) ? 'existing' : (has(meta.description) ? 'fallback' : 'none'),
      logo: has(cur.logo_url) ? 'existing' : (has(meta.logo_url) ? 'fallback' : 'none'),
    }
    return { status: canonical?.domain ? 'partial' : 'failed', stages }
  }
}
