import { computeNetworkCompanies, ENRICH_RETRY_MS } from '@/lib/company/enrich'
import {
  classifyCompany,
  needsEnrichment,
  ENRICHMENT_VERSION,
  type CompanyRowLike,
  type ClassifyOptions,
} from './version'

export interface EnrichmentReport {
  version: number
  versioningEnabled: boolean
  total: number // companies in the member graph
  upToDate: number // enriched at the current version
  pending: number // in_progress (a run mid-flight)
  failed: number
  notFound: number
  partial: number // enriched-but-incomplete
  outdatedVersion: number // enriched under an older version
  newlyCreatedNotEnriched: number // in the graph but no row yet, or never attempted
  needsWork: number // total an incremental run would process now
  orphanRows: number // company rows not in the member graph
}

/**
 * Pure incremental-enrichment census over the member-graph companies. Pass the
 * network slugs, a slug→row lookup, and the total company-row count. Every
 * network company lands in exactly one status bucket; `needsWork` is the count
 * an incremental run would actually process right now.
 */
export function buildEnrichmentReport(
  networkSlugs: string[],
  rowBySlug: Map<string, CompanyRowLike> | Record<string, CompanyRowLike>,
  totalRows: number,
  opts: ClassifyOptions = {},
): EnrichmentReport {
  const get = (s: string): CompanyRowLike | undefined =>
    rowBySlug instanceof Map ? rowBySlug.get(s) : rowBySlug[s]

  let upToDate = 0, pending = 0, failed = 0, notFound = 0, partial = 0, outdated = 0, newly = 0, needs = 0
  let networkRowsPresent = 0
  for (const slug of networkSlugs) {
    const row = get(slug)
    if (row) networkRowsPresent++
    switch (classifyCompany(row, opts)) {
      case 'up_to_date': upToDate++; break
      case 'in_progress': pending++; break
      case 'failed': failed++; break
      case 'not_found': notFound++; break
      case 'partial': partial++; break
      case 'outdated_version': outdated++; break
      case 'missing':
      case 'never_enriched': newly++; break
    }
    if (needsEnrichment(row, opts)) needs++
  }

  return {
    version: opts.version ?? ENRICHMENT_VERSION,
    versioningEnabled: opts.versioningEnabled ?? true,
    total: networkSlugs.length,
    upToDate,
    pending,
    failed,
    notFound,
    partial,
    outdatedVersion: outdated,
    newlyCreatedNotEnriched: newly,
    needsWork: needs,
    orphanRows: Math.max(0, totalRows - networkRowsPresent),
  }
}

/**
 * DB-backed report loader shared by the cron runner and the admin diagnostic.
 * Read-only. Transparently degrades if the `enrichment_version` column isn't
 * applied yet (migration 017): it re-selects without the column and reports
 * `versioningEnabled: false`, so the endpoint works before and after the migration.
 */
export async function loadEnrichmentReport(admin: any, retryMs: number = ENRICH_RETRY_MS): Promise<EnrichmentReport> {
  const { data: profs } = await admin.from('profiles').select('company').not('company', 'is', null)
  const network = computeNetworkCompanies(profs)

  const fullCols = 'slug, admin_edited, enrichment_status, enrichment_attempted_at, enrichment_version'
  let res = await admin.from('companies').select(fullCols)
  let versioningEnabled = true
  if (res.error && /enrichment_version/i.test(res.error.message || '')) {
    res = await admin.from('companies').select('slug, admin_edited, enrichment_status, enrichment_attempted_at')
    versioningEnabled = false
  }
  if (res.error) throw new Error(res.error.message)

  const rows = (res.data || []) as CompanyRowLike[] & { slug: string }[]
  const bySlug = new Map<string, CompanyRowLike>((rows as any[]).map((r) => [r.slug, r]))
  return buildEnrichmentReport(
    network.map((c) => c.slug),
    bySlug,
    rows.length,
    { versioningEnabled, retryMs },
  )
}
