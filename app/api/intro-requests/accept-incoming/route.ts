import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { promoteIfResolved } from '@/lib/introductions/queue'
import { notifyNewVisibleBatch } from '@/lib/notifications/engagement'
import { finalizeMutualMatch } from '@/lib/introductions/finalizeMutualMatch'
import { fetchActionableIncomingInterest } from '@/lib/introductions/incomingInterest'

/**
 * Accept incoming member-initiated interest (the "Interested in you" surface).
 *
 * `introRequestId` is the EXPRESSER's row (requester = the interested member,
 * target = the viewer, status 'approved', member-initiated). This is the FINAL
 * confirmation step ("Connect and use 1 credit") — the client's first Accept click
 * only opens a read-only review and never calls this route.
 *
 * On confirm we express the viewer's reciprocal interest on the fly — reusing the
 * viewer's existing recommendation row for the expresser when one exists (so the
 * active/queued batch resolves correctly), or creating one when it doesn't (the
 * common case for members who never received a reciprocal card) — then run the
 * shared mutual-match finalizer, which charges both, creates the match +
 * conversation, notifies, emails, and retires the waiting reminder.
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { introRequestId } = await request.json().catch(() => ({}))
  if (!introRequestId) {
    return NextResponse.json({ error: 'introRequestId required' }, { status: 400 })
  }

  const adminClient = createAdminClient()

  // Load the expresser's row and confirm the viewer is its target.
  const { data: incoming } = await adminClient
    .from('intro_requests')
    .select('id, requester_id, target_user_id, status, is_admin_initiated')
    .eq('id', introRequestId)
    .maybeSingle()

  if (!incoming) {
    return NextResponse.json({ error: 'Intro request not found' }, { status: 404 })
  }
  if (incoming.target_user_id !== user.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 })
  }

  const expresserId = incoming.requester_id
  const viewerId = user.id

  // Single source of truth: only accept an item that IS actionable per the same
  // definition the page renders and the reminder gate uses. This rejects rows that
  // are admin-initiated, no longer approved, already matched, same-company, or from
  // a deactivated expresser — without re-implementing the rules here.
  const actionable = await fetchActionableIncomingInterest(adminClient, viewerId, { viaServiceRole: true })
  if (!actionable.some((i) => i.introRequestId === introRequestId)) {
    return NextResponse.json(
      { error: 'This request is no longer available.', message: 'This introduction is no longer available. No credit was used.' },
      { status: 409 },
    )
  }

  // Express the viewer's reciprocal interest. Reuse an existing non-terminal
  // viewer→expresser row (resolves the batch card correctly); otherwise create one.
  const TERMINAL = ['declined', 'passed', 'archived', 'expired']
  const { data: reverseRows } = await adminClient
    .from('intro_requests')
    .select('id, status, batch_id')
    .eq('requester_id', viewerId)
    .eq('target_user_id', expresserId)
    .order('created_at', { ascending: false })

  const reusable = (reverseRows ?? []).find((r: any) => !TERMINAL.includes(r.status))

  if (reusable) {
    const { error: updErr } = await adminClient
      .from('intro_requests')
      .update({ status: 'approved', updated_at: new Date().toISOString() })
      .eq('id', reusable.id)
    if (updErr) {
      console.error('[accept-incoming] reciprocal update failed:', updErr)
      return NextResponse.json({ error: 'Could not record your interest. Please try again.' }, { status: 500 })
    }
  } else {
    const { error: insErr } = await adminClient.from('intro_requests').insert({
      requester_id: viewerId,
      target_user_id: expresserId,
      status: 'approved',
      is_admin_initiated: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    if (insErr) {
      console.error('[accept-incoming] reciprocal insert failed:', insErr)
      return NextResponse.json({ error: 'Could not record your interest. Please try again.' }, { status: 500 })
    }
  }

  // Advance the viewer's queue if this resolved the last card in their active batch
  // (idempotent, non-fatal — mirrors express-interest).
  await promoteIfResolved(adminClient, viewerId)
    .then((promo) => {
      if (promo.promoted && promo.newActive) return notifyNewVisibleBatch(viewerId, promo.newActive)
    })
    .catch((e) => console.error('[accept-incoming] promoteIfResolved failed (non-fatal):', e))

  // Both sides have now expressed → finalize the mutual match via the shared path.
  const result = await finalizeMutualMatch({
    supabase,
    adminClient,
    actingUserId: viewerId,
    otherUserId: expresserId,
    isAdminInitiated: false,
  })
  return NextResponse.json(result.body, { status: result.status })
}
