import { ENRICH_RETRY_MS } from '@/lib/company/enrich'

/**
 * ENRICHMENT_VERSION — the current enrichment "standard / schema version".
 *
 * Bump this by 1 whenever the enrichment pipeline changes in a way that should
 * re-flow through existing pages (a new extracted field, better discovery, a
 * schema change). Every successful enrich stamps `companies.enrichment_version`
 * with this value (see run.ts `finalize`). A row whose stamp is NULL or less
 * than ENRICHMENT_VERSION is classified `outdated_version` and becomes eligible
 * for a forced re-enrich on the next incremental run — with no manual list.
 *
 * History:
 *   1 — initial versioned pipeline (registry + homepage scrape + Storage logo).
 */
export const ENRICHMENT_VERSION = 1

/** One-of enrichment state for a company (or a not-yet-materialized row). */
export type EnrichmentCategory =
  | 'missing' // in the member graph but no companies row yet
  | 'never_enriched' // row exists, never attempted (status NULL)
  | 'in_progress' // a run is mid-flight (or a stale claim)
  | 'failed' // last run threw / could not persist
  | 'not_found' // no discoverable website (registry miss + search)
  | 'partial' // identity resolved but homepage metadata incomplete
  | 'outdated_version' // enriched, but under an older ENRICHMENT_VERSION
  | 'up_to_date' // enriched at the current version — skip

export interface CompanyRowLike {
  enrichment_status?: string | null
  enrichment_attempted_at?: string | null
  enrichment_version?: number | null
  admin_edited?: boolean | null
}

export interface ClassifyOptions {
  now?: number
  retryMs?: number
  version?: number
  /**
   * Whether the `enrichment_version` column is live (migration 017 applied).
   * When false, versioning is inert: an `enriched` row is `up_to_date`
   * regardless of its (absent) stamp, so pre-migration behavior is unchanged.
   */
  versioningEnabled?: boolean
}

/** Bucket a company row (or a missing row) into exactly one category. */
export function classifyCompany(
  row: CompanyRowLike | null | undefined,
  opts: ClassifyOptions = {},
): EnrichmentCategory {
  if (!row) return 'missing'
  const version = opts.version ?? ENRICHMENT_VERSION
  const versioningEnabled = opts.versioningEnabled ?? true
  switch (row.enrichment_status ?? null) {
    case null:
      return 'never_enriched'
    case 'failed':
      return 'failed'
    case 'not_found':
      return 'not_found'
    case 'in_progress':
      return 'in_progress'
    case 'partial':
      return 'partial'
    case 'enriched':
      if (versioningEnabled && (row.enrichment_version == null || row.enrichment_version < version)) {
        return 'outdated_version'
      }
      return 'up_to_date'
    default:
      // Unknown / legacy status → treat conservatively as needing attention.
      return 'never_enriched'
  }
}

/**
 * The single source of truth for "should an incremental run process this
 * company?" — no manual list. `admin_edited` rows are NEVER processed. The
 * retryable-but-terminal states (failed / not_found / partial / stale
 * in_progress) are only re-eligible after the retry cooldown, which keeps runs
 * idempotent and lets `not_found` self-heal once discovery improves.
 */
export function needsEnrichment(row: CompanyRowLike | null | undefined, opts: ClassifyOptions = {}): boolean {
  if (row?.admin_edited) return false
  const now = opts.now ?? Date.now()
  const retryMs = opts.retryMs ?? ENRICH_RETRY_MS
  switch (classifyCompany(row, opts)) {
    case 'missing':
    case 'never_enriched':
    case 'outdated_version':
      return true
    case 'up_to_date':
      return false
    case 'failed':
    case 'not_found':
    case 'partial':
    case 'in_progress': {
      const attempted = row?.enrichment_attempted_at ? new Date(row.enrichment_attempted_at).getTime() : 0
      return !attempted || now - attempted > retryMs
    }
  }
}

/**
 * Whether processing this row requires `runEnrichment({ force: true })`. Only an
 * already-`enriched` but outdated row does: runEnrichment's atomic-claim filter
 * already admits null / failed / not_found / partial / stale-in_progress, but it
 * refuses to re-run an `enriched` row without `force`.
 */
export function requiresForce(row: CompanyRowLike | null | undefined, opts: ClassifyOptions = {}): boolean {
  return classifyCompany(row, opts) === 'outdated_version'
}
