import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/admin/requireAdmin'

/**
 * PATCH /api/admin/concierge/[id]
 *
 * Admin-gated Concierge status transitions (Step 4 — triage only).
 * Allowed:
 *   - pending     -> reviewing
 *   - (any non-closed) -> closed
 *
 * Deliberately does NOT support match_found / introduced here — those belong to
 * the later Create-Andrel-Intro step. No matching, scoring, or intro_requests
 * logic lives in this route.
 */
const ALLOWED_TARGET = new Set(['reviewing', 'closed'])

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  // Admin-only — non-admins rejected server-side via the shared gate.
  const { error: authError } = await requireAdmin()
  if (authError) return authError

  let body: { status?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const target = body.status
  if (!target || !ALLOWED_TARGET.has(target)) {
    return NextResponse.json({ error: 'Invalid status transition' }, { status: 400 })
  }

  const admin = createAdminClient()

  // Validate the transition against the current state.
  const { data: current, error: readErr } = await admin
    .from('concierge_requests')
    .select('status')
    .eq('id', params.id)
    .maybeSingle()

  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })
  if (!current) return NextResponse.json({ error: 'Request not found' }, { status: 404 })

  const allowed =
    (target === 'reviewing' && current.status === 'pending') ||
    (target === 'closed' && current.status !== 'closed')

  if (!allowed) {
    return NextResponse.json(
      { error: `Cannot move ${current.status} → ${target}` },
      { status: 409 }
    )
  }

  const { error } = await admin
    .from('concierge_requests')
    .update({ status: target, updated_at: new Date().toISOString() })
    .eq('id', params.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true })
}
