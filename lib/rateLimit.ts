/**
 * Durable, atomic per-key rate limiting backed by the `bump_rate_limit` RPC (migration 056). Fixed
 * windows; the RPC's INSERT ... ON CONFLICT DO UPDATE ... RETURNING makes each increment atomic, so
 * concurrent callers can never both slip under the limit. service_role only (called from server code).
 *
 * FAILS CLOSED: if the RPC errors, times out, is unavailable, or returns malformed data, the result is
 * `'error'` — the caller must REJECT (503), never authorize. Only an authoritative numeric count decides
 * `'allowed'` vs `'over_limit'`. There is no in-memory fallback. Logs are coarse (error class only) —
 * never the bucket key, a UUID, or a raw DB error string.
 */
export type RateLimitOutcome =
  | { status: 'allowed'; retryAfterSeconds: number; count: number }
  | { status: 'over_limit'; retryAfterSeconds: number; count: number }
  | { status: 'error'; retryAfterSeconds: number }

export async function checkRateLimit(
  admin: any,
  opts: { key: string; limit: number; windowSeconds: number; now?: number; timeoutMs?: number },
): Promise<RateLimitOutcome> {
  const nowMs = opts.now ?? Date.now()
  const windowMs = opts.windowSeconds * 1000
  const windowStartMs = Math.floor(nowMs / windowMs) * windowMs
  const windowStart = new Date(windowStartMs).toISOString()
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStartMs + windowMs - nowMs) / 1000))
  const timeoutMs = opts.timeoutMs ?? 3000

  let raced: any
  try {
    let timer: any
    const timeout = new Promise<{ __timeout: true }>((resolve) => { timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs) })
    try {
      raced = await Promise.race([
        admin.rpc('bump_rate_limit', { p_bucket_key: opts.key, p_window_start: windowStart }),
        timeout,
      ])
    } finally {
      clearTimeout(timer)
    }
  } catch (e: any) {
    console.error('[rateLimit] rpc_threw', e?.name || 'error')
    return { status: 'error', retryAfterSeconds }
  }

  if (!raced || raced.__timeout) {
    console.error('[rateLimit] rpc_timeout')
    return { status: 'error', retryAfterSeconds }
  }
  const { data, error } = raced
  if (error) {
    console.error('[rateLimit] rpc_error', error?.code || 'db_error')
    return { status: 'error', retryAfterSeconds }
  }
  const count = typeof data === 'number' ? data : Number(data)
  if (!Number.isFinite(count) || count < 1) {
    console.error('[rateLimit] malformed_count')
    return { status: 'error', retryAfterSeconds }
  }
  return count <= opts.limit
    ? { status: 'allowed', retryAfterSeconds, count }
    : { status: 'over_limit', retryAfterSeconds, count }
}
