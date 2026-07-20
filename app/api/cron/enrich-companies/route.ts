import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { computeNetworkCompanies } from '@/lib/company/enrich'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Self-population pass for Company Context pages. Runs on a schedule so pages
 * populate themselves over time with NO manual maintenance.
 *
 * STEP 1 (active): materialize a canonical record (slug + display name) for every
 *   company that members actually work at but doesn't have a row yet — so each
 *   company has a persistent, curatable record.
 *
 * STEP 2 (seam, not yet wired): an enrichment provider fills the richer fields
 *   (logo_url, industry, headquarters, company_size, description). When added it
 *   MUST update ONLY rows where admin_edited = false, so a human's edits in
 *   /dashboard/admin/companies are authoritative and never overwritten.
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

  const existing = await admin.from('companies').select('slug, admin_edited')
  if (existing.error) {
    // Table not applied yet — nothing to do.
    return NextResponse.json({ ok: false, reason: 'companies_table_absent' }, { status: 200 })
  }
  const existingSlugs = new Set((existing.data || []).map((r: any) => r.slug))
  const adminEdited = (existing.data || []).filter((r: any) => r.admin_edited).length

  // Insert canonical records only for companies with no row yet. ignoreDuplicates
  // + the pre-filter guarantee we never touch existing or admin-edited rows.
  const toInsert = network
    .filter(c => !existingSlugs.has(c.slug))
    .map(c => ({ slug: c.slug, name: c.name, enrichment_source: 'auto:name', enriched_at: new Date().toISOString() }))

  let created = 0
  for (let i = 0; i < toInsert.length; i += 200) {
    const batch = toInsert.slice(i, i + 200)
    const { error } = await admin.from('companies').upsert(batch, { onConflict: 'slug', ignoreDuplicates: true })
    if (!error) created += batch.length
    else console.error('[enrich-companies] insert batch failed:', error.message)
  }

  console.log(`[enrich-companies] network=${network.length} existing=${existingSlugs.size} adminEdited=${adminEdited} created=${created}`)
  return NextResponse.json({
    ok: true,
    networkCompanies: network.length,
    existing: existingSlugs.size,
    adminEdited,
    created,
  })
}
