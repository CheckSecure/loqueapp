import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { computeNetworkCompanies, ENRICH_RETRY_MS } from '@/lib/company/enrich'
import { runEnrichment } from '@/lib/company/enrichment/run'
import { needsEnrichment, requiresForce, ENRICHMENT_VERSION } from '@/lib/company/enrichment/version'
import { buildEnrichmentReport } from '@/lib/company/enrichment/report'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * RECONCILIATION / BACKFILL ONLY — not the primary mechanism.
 *
 * Records are created + enriched lazily the moment a company page is first
 * opened (a background trigger calls the self-hosted enrichment pipeline). This
 * weekly job only catches the gaps: companies whose page nobody has opened yet,
 * or whose earlier enrichment failed and is now past the retry window.
 *
 * It runs the SAME pipeline (runEnrichment), so its atomic claim guarantees it
 * never touches admin_edited rows, never re-runs already-enriched rows, and
 * never double-runs a company being enriched concurrently by a page view.
 *
 * Deploy-safe: if the companies table isn't applied yet, this no-ops cleanly.
 */
export async function GET(req: Request) {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  const { data: profs } = await admin.from('profiles').select('company').not('company', 'is', null)
  const network = computeNetworkCompanies(profs)

  // Select enrichment_version too; transparently degrade if migration 017 isn't
  // applied yet (column absent) — versioning goes inert, everything else works.
  let existing = await admin.from('companies').select('slug, admin_edited, enrichment_status, enrichment_attempted_at, enrichment_version')
  let versioningEnabled = true
  if (existing.error && /enrichment_version/i.test(existing.error.message || '')) {
    existing = await admin.from('companies').select('slug, admin_edited, enrichment_status, enrichment_attempted_at')
    versioningEnabled = false
  }
  if (existing.error) {
    // Table not applied yet — nothing to do.
    return NextResponse.json({ ok: false, reason: 'companies_table_absent' }, { status: 200 })
  }
  const bySlug = new Map((existing.data || []).map((r: any) => [r.slug, r]))
  const opts = { versioningEnabled, retryMs: ENRICH_RETRY_MS }

  // Census BEFORE processing — the incremental report (auto-detected, no manual list).
  const report = buildEnrichmentReport(network.map((c) => c.slug), bySlug, (existing.data || []).length, opts)

  // Bound scrape volume per run; the weekly cadence chips away at the rest.
  const MAX_ENRICH_CALLS = 60
  let enriched = 0, notFound = 0, failed = 0, skipped = 0, calls = 0

  for (const c of network) {
    if (calls >= MAX_ENRICH_CALLS) break
    const row = bySlug.get(c.slug)
    // Single source of truth for "needs work" (missing / never / failed /
    // not_found / partial past retry / stale / outdated version). Outdated
    // enriched rows need force to bypass runEnrichment's enriched-skip.
    if (!needsEnrichment(row, opts)) { skipped++; continue }
    const r = await runEnrichment(admin, c.slug, c.name, { force: requiresForce(row, opts) })
    if (r.status === 'skipped' || r.status === 'error') { skipped++; continue }
    calls++
    if (r.status === 'enriched') enriched++
    else if (r.status === 'not_found') notFound++
    else failed++
  }

  console.log(`[enrich-companies] v=${ENRICHMENT_VERSION} network=${network.length} existing=${bySlug.size} calls=${calls} enriched=${enriched} notFound=${notFound} failed=${failed} skipped=${skipped}`)
  return NextResponse.json({
    ok: true,
    enrichmentVersion: ENRICHMENT_VERSION,
    versioningEnabled,
    report,
    networkCompanies: network.length,
    existing: bySlug.size,
    calls,
    enriched,
    notFound,
    failed,
    skipped,
  })
}
