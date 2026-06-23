import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { createAdminIntroPair } from '@/lib/introRequests/createAdminIntroPair'

/**
 * POST /api/admin/concierge/[id]/introduce   { candidate_id, match_reason? }
 *
 * Admin selects a recommended candidate and creates an Andrel introduction.
 * Reuses createAdminIntroPair (the shared admin-intro path) — two reciprocal
 * admin_pending / is_admin_initiated rows, NO matches row. On success the
 * Concierge request moves to status 'introduced'.
 */

/** Concise, honest fallback reason from the request — no invented claims. */
function buildConciergeReason(req: any): string {
  const target = [req.target_role, req.target_company, req.target_industry]
    .filter(Boolean)
    .join(' · ')
  return target
    ? `Introduced by Andrel for your Concierge request (${target}).`
    : 'Introduced by Andrel at your request.'
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const { error: authError } = await requireAdmin()
  if (authError) return authError

  let body: { candidate_id?: string; match_reason?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const candidateId = typeof body.candidate_id === 'string' ? body.candidate_id : ''
  if (!candidateId) {
    return NextResponse.json({ error: 'candidate_id is required' }, { status: 400 })
  }
  const providedReason =
    typeof body.match_reason === 'string' && body.match_reason.trim()
      ? body.match_reason.trim()
      : null

  const admin = createAdminClient()

  // Resolve the requester from the Concierge request id — never trust the client.
  const { data: reqRow, error: reqErr } = await admin
    .from('concierge_requests')
    .select('id, requester_id, status, target_person, target_role, target_company, target_industry')
    .eq('id', params.id)
    .maybeSingle()

  if (reqErr) return NextResponse.json({ error: reqErr.message }, { status: 500 })
  if (!reqRow) return NextResponse.json({ error: 'Concierge request not found' }, { status: 404 })

  const matchReason = providedReason || buildConciergeReason(reqRow)

  const result = await createAdminIntroPair(reqRow.requester_id, candidateId, {
    matchReason,
    adminNotes: 'concierge',
  })

  if (!result.ok) {
    const status = result.code === 'invalid_pair' ? 400 : result.code === 'insert_failed' ? 500 : 409
    return NextResponse.json({ error: result.message, code: result.code }, { status })
  }

  // Duplicate-pair guard: an Andrel intro already exists for this pair.
  if (result.mode === 'intro_already_proposed') {
    return NextResponse.json(
      { error: 'An Andrel introduction already exists for this pair.', code: 'already_proposed' },
      { status: 409 }
    )
  }

  // Intro created — advance the Concierge request.
  const { error: updErr } = await admin
    .from('concierge_requests')
    .update({ status: 'introduced', updated_at: new Date().toISOString() })
    .eq('id', params.id)

  if (updErr) {
    // The intro rows were created; only the status bump failed. Surface, don't 500.
    console.error('[concierge/introduce] status update failed:', updErr)
  }

  return NextResponse.json({ success: true, introRequests: result.introRequests })
}
