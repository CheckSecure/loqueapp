import { NextRequest, NextResponse } from 'next/server'
import { isAllowedMetric, sanitizeDims } from '@/lib/metrics'

export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 1024
const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 60
const hits = new Map<string, number[]>()

// Best-effort, per-instance rate limit. Serverless instances don't share this map, so it is
// not a hard guarantee — it's an abuse speed-bump. Sensitive decisions use SERVER-side events
// (provisioning), never these client beacons.
function rateLimited(ip: string): boolean {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  recent.push(now)
  hits.set(ip, recent)
  if (hits.size > 5000) for (const [k, v] of Array.from(hits.entries())) if (v.every((t: number) => now - t >= WINDOW_MS)) hits.delete(k)
  return recent.length > MAX_PER_WINDOW
}

/**
 * Client metric beacon — informational only, never an authoritative audit/security record.
 * Hardened against abuse: strict same-origin, JSON content-type, ≤1KB body, allowlisted
 * metric names, and dimensions capped + stripped of any URL/email/token/PII by sanitizeDims
 * (arrays/nested objects are rejected). It only emits a structured server log line — it reads
 * no cookies/tokens and writes to no table.
 */
export async function POST(req: NextRequest) {
  try {
    // Same-origin only (reject cross-site beacons).
    const origin = req.headers.get('origin')
    const host = req.headers.get('host')
    if (origin) {
      try { if (new URL(origin).host !== host) return NextResponse.json({ ok: false }, { status: 403 }) }
      catch { return NextResponse.json({ ok: false }, { status: 403 }) }
    }

    // Strict content type.
    if (!(req.headers.get('content-type') ?? '').includes('application/json')) {
      return NextResponse.json({ ok: false }, { status: 415 })
    }

    // Rate limit (best-effort).
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
    if (rateLimited(ip)) return NextResponse.json({ ok: false }, { status: 429 })

    // Small body only.
    const raw = await req.text()
    if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ ok: false }, { status: 413 })

    const body = JSON.parse(raw || '{}')
    if (!isAllowedMetric(body?.metric)) return NextResponse.json({ ok: false }, { status: 400 })
    // sanitizeDims rejects arrays/objects and strips PII/secret-like keys and values.
    const dims = sanitizeDims(body?.dims ?? {})

    console.log('[metric]', JSON.stringify({ metric: body.metric, source: 'client', ...dims }))
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }
}
