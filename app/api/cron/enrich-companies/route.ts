import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { computeNetworkCompanies } from '@/lib/company/enrich'
import { runEnrichment } from '@/lib/company/enrichment/run'

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

  const existing = await admin.from('companies').select('slug, admin_edited, enrichment_status')
  if (existing.error) {
    // Table not applied yet — nothing to do.
    return NextResponse.json({ ok: false, reason: 'companies_table_absent' }, { status: 200 })
  }
  const bySlug = new Map((existing.data || []).map((r: any) => [r.slug, r]))

  // Bound scrape volume per run; the weekly cadence chips away at the rest.
  const MAX_ENRICH_CALLS = 60
  let enriched = 0, notFound = 0, failed = 0, skipped = 0, calls = 0

  for (const c of network) {
    if (calls >= MAX_ENRICH_CALLS) break
    const row = bySlug.get(c.slug)
    // Cheap pre-filter (the pipeline's atomic claim is the real gate).
    if (row?.admin_edited || row?.enrichment_status === 'enriched') { skipped++; continue }
    const r = await runEnrichment(admin, c.slug, c.name)
    if (r.status === 'skipped' || r.status === 'error') { skipped++; continue }
    calls++
    if (r.status === 'enriched') enriched++
    else if (r.status === 'not_found') notFound++
    else failed++
  }

  console.log(`[enrich-companies] network=${network.length} existing=${bySlug.size} calls=${calls} enriched=${enriched} notFound=${notFound} failed=${failed} skipped=${skipped}`)
  return NextResponse.json({
    ok: true,
    networkCompanies: network.length,
    existing: bySlug.size,
    calls,
    enriched,
    notFound,
    failed,
    skipped,
  })
}
