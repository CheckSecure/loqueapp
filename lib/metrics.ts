/**
 * lib/metrics.ts — lightweight, log-based operational metrics.
 *
 * Emits a single structured line per event so log drains / alerting can build counters and
 * fire before users report problems. Server code logs directly; client code beacons to
 * /api/metrics so browser-side events (recovery) still reach server logs.
 *
 * HARD RULE: metrics NEVER carry secrets. Dimension keys matching token/password/secret/
 * hash/cookie/authorization/key are dropped, and string values are length-capped. Callers
 * must pass only categorical dimensions (outcome, tier, step) — never a token or password.
 */

export const PROVISIONING_METRICS = [
  'provisioning_success',
  'provisioning_retry',
  'provisioning_failure',
  'provisioning_reconciled',
] as const

export const RECOVERY_METRICS = [
  'recovery_email_requested',
  'recovery_verify_success',
  'recovery_verify_expired',
  'recovery_verify_reused',
  'recovery_verify_invalid',
  'recovery_password_changed',
] as const

export const ALLOWED_METRICS: readonly string[] = [...PROVISIONING_METRICS, ...RECOVERY_METRICS]
export type MetricName = (typeof PROVISIONING_METRICS)[number] | (typeof RECOVERY_METRICS)[number]

const FORBIDDEN_DIM_KEY = /token|password|secret|hash|authorization|cookie|bearer|key|email|url|uri/i
// Reject values that look like PII/secrets: emails, URLs, protocol-relative refs, or JWT-ish blobs.
const PII_VALUE = /@|https?:\/\/|\/\/|eyJ[A-Za-z0-9_-]{10,}/i
const MAX_DIMS = 8

export function sanitizeDims(dims: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (!dims || typeof dims !== 'object' || Array.isArray(dims)) return out
  let count = 0
  for (const [k, v] of Object.entries(dims)) {
    if (count >= MAX_DIMS) break
    if (FORBIDDEN_DIM_KEY.test(k)) continue
    if (v == null) continue
    // Only scalar values — arrays/objects are dropped (no nested structures).
    if (typeof v === 'string') {
      if (PII_VALUE.test(v)) continue // never let a URL/email/token slip through
      out[k] = v.slice(0, 80)
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v
    } else {
      continue
    }
    count++
  }
  return out
}

export function isAllowedMetric(name: unknown): name is MetricName {
  return typeof name === 'string' && ALLOWED_METRICS.includes(name)
}

/**
 * Emit a metric. Best-effort and non-throwing — instrumentation must never break a flow.
 * Server: structured console line. Client: sendBeacon/fetch to /api/metrics.
 */
export function emitMetric(name: MetricName, dims: Record<string, unknown> = {}): void {
  const safe = sanitizeDims(dims)
  try {
    if (typeof window === 'undefined') {
      console.log('[metric]', JSON.stringify({ metric: name, ...safe }))
      return
    }
    const body = JSON.stringify({ metric: name, dims: safe })
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/metrics', new Blob([body], { type: 'application/json' }))
    } else {
      void fetch('/api/metrics', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } })
    }
  } catch {
    /* metrics are best-effort; never surface an error to the caller */
  }
}
