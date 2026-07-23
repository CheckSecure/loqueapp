import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { LOGO_BUCKET } from '@/lib/company/enrichment/logo'
import { discoveryProvider } from '@/lib/company/enrichment/discovery'
import { loadEnrichmentReport } from '@/lib/company/enrichment/report'
import { ENRICHMENT_VERSION } from '@/lib/company/enrichment/version'

export const runtime = 'nodejs'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * Runtime diagnostic for the self-hosted enrichment pipeline. Reports readiness
 * without any secret: the pipeline needs no API key. Confirms the Storage bucket
 * exists/writable and the companies table is present. Admin-only.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()

  // Bucket probe — list() succeeds only if the bucket exists and is reachable.
  let bucketOk = false
  let bucketError: string | null = null
  try {
    const { error } = await admin.storage.from(LOGO_BUCKET).list('', { limit: 1 })
    if (error) bucketError = error.message
    else bucketOk = true
  } catch (e: any) {
    bucketError = e?.message || 'probe_failed'
  }

  // Table probe.
  const tbl = await admin.from('companies').select('slug', { head: true, count: 'exact' }).limit(1)
  const tableOk = !tbl.error

  // Incremental census — auto-detected across all categories, no manual list.
  let report = null
  let reportError: string | null = null
  if (tableOk) {
    try {
      report = await loadEnrichmentReport(admin)
    } catch (e: any) {
      reportError = e?.message || 'report_failed'
    }
  }

  return NextResponse.json({
    pipeline: 'self-hosted (homepage scrape + Supabase Storage)',
    enrichmentEnabled: true,          // no API key required — always on
    enrichmentVersion: ENRICHMENT_VERSION,
    discoveryProvider: discoveryProvider.name,
    logoBucket: LOGO_BUCKET,
    bucketReachable: bucketOk,
    bucketError,
    companiesTableReady: tableOk,
    companiesTableError: tbl.error?.message ?? null,
    report,
    reportError,
    vercelEnv: process.env.VERCEL_ENV || null,
  })
}
