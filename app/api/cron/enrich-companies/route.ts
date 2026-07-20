import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { computeNetworkCompanies } from '@/lib/company/enrich'

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
