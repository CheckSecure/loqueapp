import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateReciprocalBatchForMember } from '@/lib/generate-recommendations'
import { enqueueOnboardingRetry } from '@/lib/onboarding/retryQueue'

// Never cache a state-changing admin response.
const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: any, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

/**
 * Single-member recovery for onboarding reciprocal recommendations.
 *
 * For members who completed onboarding BEFORE the reliability fix (commit c71bd81) and have no
 * reciprocal pair/cards. It re-invokes the EXACT deployed onboarding generator once — same
 * eligibility, fair scoring, capacity/blocking/history checks, 4s deadline, call caps, and
 * idempotency. It performs NO direct writes to member_pairs/intro_requests/matches/conversations/
 * credits/notifications and sends NO email/in-app notification. Strictly single-UUID: no cohort,
 * wildcard, array, bulk, or profile-scan capability exists here.
 *
 * Response + logs are privacy-safe: an outcome + counts only — never a member/candidate identity.
 */

// Canonical UUID (v1–5). A comma/space-separated "multiple ids" string, "*", or malformed value fails.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const bad = (message: string) => json({ error: message }, 400)

export async function POST(req: Request) {
  // 0. CSRF: reject cross-origin requests (cookie-authed state change). Standard headers only.
  const crossOrigin = assertSameOrigin(req)
  if (crossOrigin) return crossOrigin

  // 1–2. Authorize the admin FIRST — before any service-role client or production read.
  const { error } = await requireAdmin()
  if (error) return error

  // Reject anything that isn't a JSON API call (blocks HTML form submissions / simple-request CSRF).
  const ctype = req.headers.get('content-type') ?? ''
  if (!ctype.toLowerCase().includes('application/json')) return bad('Content-Type must be application/json')

  // 3–5. Parse + strictly validate EXACTLY one UUID. Reject arrays/objects/multiples/wildcards/
  //       missing ids and any extra keys that would imply a cohort/bulk request.
  let body: any
  try { body = await req.json() } catch { return bad('Invalid JSON body') }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return bad('Body must be an object { userId }')
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'userId') return bad('Body must contain exactly one field: userId')
  const userId = body.userId
  if (typeof userId !== 'string') return bad('userId must be a single UUID string')
  const trimmed = userId.trim()
  if (!UUID_RE.test(trimmed)) return bad('userId must be a valid UUID')

  // 6, 9. Invoke the ONE shared, deployed generator exactly once. It creates its own service-role
  //       client internally (only reached AFTER admin authorization) and enforces every safeguard.
  try {
    const result = await generateReciprocalBatchForMember(trimmed, 'onboarding')

    // Durable retry: a retryable capacity/empty/no-compatible/transient outcome persists THIS member
    // (only) so the worker re-attempts later. No-op on created/noop/ineligible. Fail-open; the flag
    // reflects whether durable retry was actually scheduled (never falsely claimed).
    const durableRetryScheduled = result.retryable ? await enqueueOnboardingRetry(createAdminClient(), trimmed, result.outcome) : false

    // 11. Audit log — records the admin-triggered recovery + outcome, NO uuid/email/name/candidate.
    console.log('[admin-recover-onboarding]', JSON.stringify({
      event: 'recovery_invoked', outcome: result.outcome, created: result.count, rpcCalls: result.rpcCalls, durableRetryScheduled,
    }))

    // 10. Privacy-safe result — outcome + counts only. No identity/email/uuid/score/profile.
    return json({
      success: true,
      outcome: result.outcome,   // created | noop_at_capacity | empty_pool | capacity | no_compatible_candidate | ineligible | transient_error
      created: result.count,
      retryable: result.retryable,
    })
  } catch (err: any) {
    // The generator handles its own transient errors; this is a last-resort guard. No raw payload.
    console.error('[admin-recover-onboarding] error (class):', err?.name ?? 'error')
    return json({ success: false, outcome: 'transient_error', retryable: true }, 500)
  }
}

// Explicitly POST-only: any other method (incl. GET navigation / prefetch) is a 405, never processed.
export async function GET() {
  return json({ error: 'Method not allowed' }, 405)
}
