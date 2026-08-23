
/**
 * Seven-year retention purge for the account-deletion ledger.
 *
 * The seven-year boundary lives in the DATABASE — in
 * public.purge_expired_account_deletion_events(), and independently in the ledger's append-only
 * trigger. It is deliberately not expressed here: this module cannot choose a cutoff, cannot aim
 * the purge at a member, and has no argument through which either could be attempted. It calls a
 * zero-argument function and reports how many rows went.
 *
 * NEVER THROWS. Retention is maintenance, not member-facing work: a failure must be visible and
 * retried on the next run, never propagated into a request that has other jobs to finish.
 */
export interface PurgeOutcome {
  /** Rows removed this run. Null when the purge did not complete. */
  removed: number | null
  /** A CLASS, never a message — provider errors routinely echo their input. */
  errorClass?: 'rpc_error' | 'unavailable'
}

/**
 * The one method this module needs. Structurally typed and injected, rather than constructing a
 * second service-role client: the caller already holds one configured with its own deadline and
 * fetch wrapper, and building another would both duplicate that configuration and fail wherever the
 * environment is not populated.
 */
export interface PurgeClient {
  rpc(fn: string, params?: any, options?: any): PromiseLike<{ data?: unknown; error: { code?: string } | null }>
}

export async function purgeExpiredDeletionEvents(client: PurgeClient): Promise<PurgeOutcome> {
  try {
    const { data, error } = await client.rpc('purge_expired_account_deletion_events')

    if (error) {
      // Shape only. No identifier, no message, no row sample.
      console.error(JSON.stringify({ event: 'deletion_ledger_purge_failed', code: error.code ?? 'unknown' }))
      return { removed: null, errorClass: 'rpc_error' }
    }
    // The function returns a bare count. Anything else is treated as "completed, count unknown"
    // rather than coerced into a number that would misreport what happened.
    const removed = typeof data === 'number' ? data : Number.isFinite(Number(data)) ? Number(data) : null
    return { removed }
  } catch {
    console.error(JSON.stringify({ event: 'deletion_ledger_purge_unavailable' }))
    return { removed: null, errorClass: 'unavailable' }
  }
}
