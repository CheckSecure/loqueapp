import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { enqueueBatch, countUnresolvedRecommendations } from '@/lib/introductions/queue'
import { notifyAdminBatchReady, notifyPendingIntrosActionNeeded, isoWeekKey } from '@/lib/notifications/engagement'

export const dynamic = 'force-dynamic'

/**
 * Admin "Send" for a reciprocal batch. In the unified queue model this no longer
 * exposes batch_suggestions to members — it MATERIALIZES the reciprocal suggestions
 * into intro_requests (the single member-facing queue) via enqueueBatch, per
 * recipient, as an 'admin_reciprocal' batch. Placement respects the active window:
 *   • empty active slot  → becomes the member's ACTIVE batch
 *   • active occupied     → becomes the QUEUED (next) batch
 *   • queued organic batch present → the organic batch is discarded, admin takes the slot
 *   • queued admin batch already present → this recipient is REJECTED (no stacking)
 * batch_suggestions is marked shown (preserving the 90-day re-suggestion cooldown)
 * and materialized_at is stamped. Member notification fires ONLY for a batch that
 * is VISIBLE now (placed ACTIVE). A queued admin batch is hidden, so it stays
 * silent here — it is announced later, once promoteIfResolved promotes it, by the
 * SAME shared helper (notifyNewVisibleBatch, dedupeKey batch:<batchId>). That
 * shared dedupe guarantees a member is emailed exactly once, when the batch first
 * becomes visible — never a premature email at approval nor a duplicate at promotion.
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || user.email !== 'bizdev91@gmail.com') {
      return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
    }

    const { batchId } = await req.json()
    if (!batchId) return NextResponse.json({ error: 'Missing batchId' }, { status: 400 })

    const adminClient = createAdminClient()

    // Idempotency guard: approval is a one-way transition from pending_review.
    // Re-approving an already active/completed batch would re-run materialization
    // (the shown-rows loader below has no materialized_at filter), so we refuse
    // BEFORE any mutation or enqueue — no double-send, no duplicate intro_requests.
    const { data: batchRow, error: loadErr } = await adminClient
      .from('introduction_batches').select('id, status').eq('id', batchId).maybeSingle()
    if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 })
    if (!batchRow) return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
    if (batchRow.status !== 'pending_review') {
      return NextResponse.json(
        { error: `Batch is already '${batchRow.status}'. Approval is only allowed from 'pending_review'; no changes were made.`, alreadyProcessed: true, status: batchRow.status },
        { status: 409 },
      )
    }

    // Mark any previous active batch as completed, then activate this one.
    await adminClient.from('introduction_batches').update({ status: 'completed' }).eq('status', 'active')
    const { error: activateErr } = await adminClient
      .from('introduction_batches').update({ status: 'active' }).eq('id', batchId)
    if (activateErr) return NextResponse.json({ error: activateErr.message }, { status: 500 })

    // Mark this batch's suggestions shown (keeps the 90-day cooldown in generate-batch)
    // and record the materialization hand-off timestamp.
    const now = new Date().toISOString()
    await adminClient
      .from('batch_suggestions')
      .update({ status: 'shown', shown_at: now, materialized_at: now })
      .eq('batch_id', batchId)
      .eq('status', 'generated')

    // Load the suggestions to materialize, grouped by recipient.
    const { data: suggestions } = await adminClient
      .from('batch_suggestions')
      .select('recipient_id, suggested_id, reason, position')
      .eq('batch_id', batchId)
      .eq('status', 'shown')

    const byRecipient = new Map<string, { target_user_id: string; match_reason: string | null }[]>()
    for (const s of suggestions || []) {
      if (!s.recipient_id || !s.suggested_id) continue
      const rows = byRecipient.get(s.recipient_id) ?? []
      rows.push({ target_user_id: s.suggested_id, match_reason: s.reason ?? null })
      byRecipient.set(s.recipient_id, rows)
    }

    // Materialize into the unified queue, per recipient.
    const placed: { recipientId: string; state: string; count: number; batchId: string }[] = []
    const rejected: { recipientId: string; reason: string }[] = []
    for (const [recipientId, rows] of Array.from(byRecipient.entries())) {
      // Keep each recipient's admin batch within the sort order the graph produced.
      const ordered = rows
      try {
        const result = await enqueueBatch(adminClient, {
          memberId: recipientId,
          source: 'admin_reciprocal',
          rows: ordered,
          reciprocalBatchId: batchId,
        })
        if (result.placed && result.batchId) {
          placed.push({ recipientId, state: result.state ?? 'queued', count: result.count ?? ordered.length, batchId: result.batchId })
        } else {
          rejected.push({ recipientId, reason: result.reason ?? 'not_placed' })
        }
      } catch (err: any) {
        console.error('[approve-batch] materialize failed for', recipientId, err?.message)
        rejected.push({ recipientId, reason: 'error' })
      }
    }

    // CANONICAL THURSDAY-SEND notification/eligibility rules — the SAME rules as
    // weekly-refresh (System A), enforced here so the admin-reviewed batch is the single
    // operational path:
    //   • VISIBLE (placed ACTIVE) → member has zero unresolved intros → the existing
    //     new-batch email (notifyAdminBatchReady; dedupe batch:<batchId>). Unchanged.
    //   • QUEUED + still-unresolved → the member must NOT see the new batch. Send the
    //     "Action needed before your next introductions" reminder via the SAME shared
    //     helper + ISO-week dedupe key (actionneeded:<ISO_WEEK>) as System A, so a member
    //     gets AT MOST ONE reminder per cycle across BOTH routes. This REPLACES the old
    //     generic "Your Andrel introductions are waiting" email (never both).
    //   • QUEUED + resolved → silent (edge; reported as otherSkipped).
    // A queued admin batch is still announced by promoteIfResolved (unchanged) when later
    // promoted to active. Reminder failures are best-effort and never block the send.
    const cycleKey = isoWeekKey(new Date())
    let batchVisible = 0
    let actionNeeded = 0
    let otherSkipped = rejected.length // rejected recipients are an "other skip"
    let newBatchEmailsSent = 0
    let actionNeededEmailsSent = 0
    let remindersAlreadyHandled = 0
    let emailFailures = 0
    for (const p of placed) {
      if (p.state === 'active') {
        await notifyAdminBatchReady(p.recipientId, p.batchId, p.count)
        batchVisible++; newBatchEmailsSent++
      } else {
        const unresolved = await countUnresolvedRecommendations(adminClient, p.recipientId)
        if (unresolved > 0) {
          actionNeeded++
          const r = await notifyPendingIntrosActionNeeded(p.recipientId, p.batchId, cycleKey)
          if (r.alreadyHandled) remindersAlreadyHandled++
          else if (r.emailed || r.skipped) actionNeededEmailsSent++
          else emailFailures++
        } else {
          otherSkipped++
        }
      }
    }

    console.log(`[approve-batch] cycle ${cycleKey}: placed=${placed.length} rejected=${rejected.length} | ${batchVisible} visible, ${actionNeeded} action-needed, ${otherSkipped} other-skipped | emails: ${newBatchEmailsSent} new-batch, ${actionNeededEmailsSent} action-needed, ${remindersAlreadyHandled} already-handled (dedup), ${emailFailures} failed`)
    if (rejected.length > 0) {
      console.warn('[approve-batch] rejected recipients (already had a queued admin batch or no candidates):', JSON.stringify(rejected))
    }

    return NextResponse.json({
      success: true,
      cycleKey,
      placed: placed.length,
      rejected: rejected.length,
      rejectedDetail: rejected,
      batchVisible,
      actionNeeded,
      otherSkipped,
      newBatchEmailsSent,
      actionNeededEmailsSent,
      remindersAlreadyHandled,
      emailFailures,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
