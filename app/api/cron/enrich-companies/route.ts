import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { computeNetworkCompanies, ensureCompanyRecord, enrichCompany } from '@/lib/company/enrich'
import { isEnrichmentEnabled } from '@/lib/company/provider'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * RECONCILIATION / BACKFILL ONLY — not the primary mechanism.
 *
 * Records are created lazily the moment a company is first encountered (see
 * ensureCompanyRecord in lib/company/enrich.ts, called from the company page).
 * This weekly job only catches the gaps: companies whose page nobody has opened
 * yet, or that were seen by viewers who knew no one there. It materializes a
 * canonical record (slug + name) for any still-missing company.
 *
 * It NEVER touches existing or admin_edited rows. A future enrichment provider
 * that fills richer fields (logo/industry/HQ/size/description) plugs in here and
 * must likewise update ONLY admin_edited = false rows.
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

  // Bound provider spend per run; the weekly cadence chips away at the rest.
  const MAX_PROVIDER_CALLS = 100
  let created = 0, enriched = 0, skipped = 0, providerCalls = 0

  for (const c of network) {
    if (providerCalls >= MAX_PROVIDER_CALLS) break
    const row = bySlug.get(c.slug)
    if (row?.admin_edited || row?.enrichment_status === 'enriched') { skipped++; continue }
    if (!row) { await ensureCompanyRecord(admin, c.slug, c.name); created++ }
    if (isEnrichmentEnabled()) {
      const r = await enrichCompany(admin, c.slug, c.name) // atomic claim gates retry + concurrency
      if (r.status === 'skipped' || r.status === 'disabled') { skipped++ }
      else { providerCalls++; if (r.status === 'enriched') enriched++ }
    }
  }

  console.log(`[enrich-companies] network=${network.length} existing=${bySlug.size} created=${created} enriched=${enriched} providerCalls=${providerCalls} enabled=${isEnrichmentEnabled()}`)
  return NextResponse.json({
    ok: true,
    networkCompanies: network.length,
    existing: bySlug.size,
    created,
    enriched,
    providerCalls,
    skipped,
    enrichmentEnabled: isEnrichmentEnabled(),
  })
}
