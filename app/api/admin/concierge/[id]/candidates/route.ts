import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { rankCandidatesForUser } from '@/lib/generate-recommendations'

/**
 * GET /api/admin/concierge/[id]/candidates
 *
 * READ-ONLY candidate recommendations for a Concierge request (Step 5a).
 *
 * Calls rankCandidatesForUser(requester_id) — the pure, no-write ranker
 * extracted from generateOnboardingRecommendations. It ranks the network for
 * the REQUESTER'S PROFILE (not yet the Concierge request's typed criteria), and
 * its pool already excludes self, deactivated, incomplete, existing matches,
 * prior/hidden/passed intros, blocked, referral, and same-company.
 *
 * Writes nothing: no intro_requests, no matches, no targeted_requests.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const { error: authError } = await requireAdmin()
  if (authError) return authError

  const admin = createAdminClient()

  // Resolve the requester from the Concierge request id (never trust the client).
  const { data: reqRow, error: reqErr } = await admin
    .from('concierge_requests')
    .select('id, requester_id')
    .eq('id', params.id)
    .maybeSingle()

  if (reqErr) return NextResponse.json({ error: reqErr.message }, { status: 500 })
  if (!reqRow) return NextResponse.json({ error: 'Request not found' }, { status: 404 })

  let ranked
  try {
    ranked = await rankCandidatesForUser(reqRow.requester_id, 5)
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Ranking failed' }, { status: 500 })
  }

  const candidates = (ranked.candidates || []).slice(0, 5).map((c: any) => ({
    id: c.id,
    name: c.full_name || 'Unnamed member',
    title: c.exact_job_title || c.title || c.role_type || null,
    company: c.company || null,
    seniority: c.seniority || null,
    score: Math.round(c.finalScore ?? 0),
    reason: c.match_reason || null,
  }))

  return NextResponse.json({
    candidates,
    // Honest framing for the admin UI — see route header.
    basis: 'requester_profile',
  })
}
