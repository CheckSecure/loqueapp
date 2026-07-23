import { ensureCompanyRecord, ENRICH_RETRY_MS } from '@/lib/company/enrich'
import { ENRICHMENT_VERSION } from './version'
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

  // Resilient finalize: writes the patch (never touching admin_edited rows). If
  // the DB rejects `partial` because the enrichment_status CHECK constraint
  // predates it (migration 016 not yet applied), degrade to `enriched` — a
  // permitted value — so the row still receives its identity + data instead of
  // getting stuck in `in_progress`. The partial vs full distinction is preserved
  // in enrichment_source ('registry' vs 'registry:homepage'). Once 016 is applied,
  // `partial` persists accurately with no code change.
  const finalize = async (patch: Record<string, unknown>) => {
    const write = (p: Record<string, unknown>) =>
      admin.from('companies').update({ ...p, updated_at: new Date().toISOString() }).eq('slug', slug).eq('admin_edited', false)
    let p = patch
    let r = await write(p)
    // Degrade if the enrichment_version column isn't applied yet (migration 024):
    // drop the version stamp and retry, so enrichment still persists. Once 024 is
    // applied, the stamp writes normally with no code change.
    if (r.error && 'enrichment_version' in p && /enrichment_version/i.test(r.error.message || '')) {
      console.warn(`[company-enrich] enrichment_version column absent (apply migration 024); persisting without stamp slug=${slug}`)
      const { enrichment_version: _drop, ...rest } = p
      p = rest
      r = await write(p)
    }
    // Degrade if the enrichment_status CHECK constraint predates 'partial'
    // (migration 016 not yet applied): 'partial' → 'enriched' (a permitted value).
    if (r.error && p.enrichment_status === 'partial' && /enrichment_status/i.test(r.error.message || '')) {
      console.warn(`[company-enrich] 'partial' rejected by constraint (apply migration 016); degrading to 'enriched' slug=${slug}`)
      r = await write({ ...p, enrichment_status: 'enriched' })
    }
    return r
  }

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
    //
    //    STALE GUARD: when a FORCE refresh corrects the website to a different
    //    host, the existing description/logo/HQ/industry were derived from the OLD
    //    (wrong) site and must NOT be preserved — prefer freshly-scraped, else the
    //    curated fallback, else clear them. (Non-force organic runs keep existing.)
    const hostOf = (u: unknown) => { try { return new URL(String(u)).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' } }
    const websiteChanged = registryResolved && has(cur.website) && hostOf(cur.website) !== hostOf(website)
    const stale = force && websiteChanged
    const keep = (v: unknown) => has(v) && !stale

    // Stamp the version on every successful (enriched/partial) persist so future
    // runs can detect outdated pages after ENRICHMENT_VERSION is bumped.
    const patch: Record<string, unknown> = { enrichment_error: null, enriched_at: new Date().toISOString(), enrichment_version: ENRICHMENT_VERSION }

    if (canonical?.name) patch.name = canonical.name                    // authoritative identity
    if (registryResolved) patch.website = website                       // authoritative domain
    else if (!has(cur.website) && has(metadata.website)) patch.website = metadata.website

    let descriptionStage: EnrichStages['description'] = 'none'
    if (keep(cur.description)) descriptionStage = 'existing'
    else if (has(metadata.description)) { patch.description = metadata.description; descriptionStage = 'scraped' }
    else if (has(meta.description)) { patch.description = meta.description; descriptionStage = 'fallback' }
    else if (stale) patch.description = null                            // drop wrong-site description

    let logoStage: EnrichStages['logo'] = 'none'
    if (keep(cur.logo_url)) logoStage = 'existing'
    else if (storedLogo) { patch.logo_url = storedLogo; logoStage = 'scraped' }
    else if (has(meta.logo_url)) { patch.logo_url = meta.logo_url; logoStage = 'fallback' }
    else if (stale) patch.logo_url = null                              // drop wrong-site logo

    if (!keep(cur.headquarters)) {
      const h = has(metadata.headquarters) ? metadata.headquarters : (has(meta.headquarters) ? meta.headquarters : (stale ? null : undefined))
      if (h !== undefined) patch.headquarters = h
    }
    if (!keep(cur.industry)) {
      const i = has(metadata.industry) ? metadata.industry : (has(meta.industry) ? meta.industry : (stale ? null : undefined))
      if (i !== undefined) patch.industry = i
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
      recover.enrichment_version = ENRICHMENT_VERSION // registry identity is a versioned success
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
