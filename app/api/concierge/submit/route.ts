import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { checkConciergeEligibility } from '@/lib/concierge/eligibility'

/**
 * POST /api/concierge/submit
 *
 * Concierge submission — server action for the admin-assisted Concierge flow.
 * Separate from /api/targeted-request/submit (credit-metered batch booster).
 *
 * Security model (see docs/migrations concierge_requests):
 *   - concierge_requests has RLS enabled with NO user write policy.
 *   - Users can only SELECT their own rows.
 *   - ALL writes go through this route using createAdminClient() (service role),
 *     AFTER the server-authoritative eligibility gate. There is no user-context
 *     write path, so the free-tier gate cannot be bypassed from the frontend.
 *   - requester_id is taken from the authenticated session, never from the body.
 */

// Length caps — keep inputs sane; values mirror the targeted-request modal scale.
const CAPS = {
  target_person: 200,
  target_role: 200,
  target_company: 200,
  target_industry: 200,
  reason: 2000,
  notes: 2000,
} as const

const TARGET_FIELDS = ['target_person', 'target_role', 'target_company', 'target_industry'] as const

/** Trim a possibly-undefined string; return null when empty. */
function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export async function POST(request: Request) {
  const supabase = createClient()

  // 1. Require an authenticated user. requester_id derives from this, not the body.
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'You must be signed in.' },
      { status: 401 }
    )
  }

  const admin = createAdminClient()

  // 2. Load the requester's profile from the authenticated session (by id = auth uid).
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select(
      'id, email, profile_complete, account_status, subscription_tier, ' +
      'is_founding_member, founding_member_expires_at'
    )
    .eq('id', user.id)
    .maybeSingle()

  if (profileError) {
    console.error('[Concierge] Profile load failed:', profileError)
    return NextResponse.json(
      { error: 'server_error', message: 'Could not load your profile.' },
      { status: 500 }
    )
  }

  // 3. Server-authoritative eligibility gate (profile_complete → active → tier).
  const eligibility = checkConciergeEligibility(profile)
  if (!eligibility.ok) {
    return NextResponse.json(
      { error: eligibility.code, message: eligibility.message },
      { status: 403 }
    )
  }

  // 4. Parse + validate the body.
  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'invalid_body', message: 'Request body must be valid JSON.' },
      { status: 400 }
    )
  }

  const fields = {
    target_person: clean(body?.target_person),
    target_role: clean(body?.target_role),
    target_company: clean(body?.target_company),
    target_industry: clean(body?.target_industry),
    reason: clean(body?.reason),
    notes: clean(body?.notes),
  }

  // Form-friendly validation errors: keyed by field plus a general bucket.
  const errors: Record<string, string> = {}

  const hasTarget = TARGET_FIELDS.some((f) => fields[f] !== null)
  if (!hasTarget) {
    errors.target = 'Add at least one detail about who you want to meet.'
  }

  if (!fields.reason) {
    errors.reason = 'Tell us what you are trying to do.'
  }

  // Length caps.
  for (const key of Object.keys(CAPS) as (keyof typeof CAPS)[]) {
    const value = fields[key]
    if (value && value.length > CAPS[key]) {
      errors[key] = `Keep this under ${CAPS[key]} characters.`
    }
  }

  if (Object.keys(errors).length > 0) {
    return NextResponse.json(
      { error: 'validation_error', message: 'Please fix the highlighted fields.', errors },
      { status: 400 }
    )
  }

  // 5. Insert via the admin client (user-context writes are blocked by RLS).
  //    requester_id comes from the authenticated session.
  const { data: inserted, error: insertError } = await admin
    .from('concierge_requests')
    .insert({
      requester_id: user.id,
      target_person: fields.target_person,
      target_role: fields.target_role,
      target_company: fields.target_company,
      target_industry: fields.target_industry,
      reason: fields.reason,
      notes: fields.notes,
      status: 'pending',
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (insertError) {
    // 6. One-active-request: the partial unique index is the source of truth.
    //    A race that slips past any pre-check still lands here as 23505.
    if ((insertError as any).code === '23505') {
      return NextResponse.json(
        {
          error: 'active_request_exists',
          message: 'You already have an active Concierge request.',
        },
        { status: 409 }
      )
    }

    console.error('[Concierge] Insert failed:', insertError)
    return NextResponse.json(
      { error: 'server_error', message: 'Could not submit your Concierge request.' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true, request: inserted })
}
