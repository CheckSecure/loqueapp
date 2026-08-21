import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { countUnresolvedRecommendations } from '@/lib/introductions/queue'
import { materializeAdminPair, toUndirectedPairs, canonicalApprovalOrder } from '@/lib/introductions/materializeAdminPair'
import { notifyAdminBatchReady, notifyPendingIntrosActionNeeded, isoWeekKey } from '@/lib/notifications/engagement'
import { finalizeWeeklyRelease } from '@/lib/introductions/batchRelease'

export const dynamic = 'force-dynamic'

/**
 * Admin "Send" for a reciprocal batch. It MATERIALIZES the reviewed proposals into
 * intro_requests (the single member-facing queue) as an 'admin_reciprocal' batch.
 *
 * THE UNIT IS AN UNDIRECTED PAIR, NOT A RECIPIENT. This previously looped recipients and
 * called enqueueBatch -> place_batch_rows once each. That RPC writes ONE direction while
 * its eligibility gate is bidirectional, so the second side of every edge was filtered out
 * by the first side's own freshly committed row — 145 live one-sided rows in production, all
 * with pair_id NULL. Approval now calls public.materialize_admin_pair (migration 064) once
 * per pair; it writes both directions with one shared pair_id under both members' advisory
 * locks, choosing ONE tier for both, or writes nothing.
 *
 * enqueueBatch/place_batch_rows is NOT retired: lib/generate-recommendations.ts (the
 * onboarding and weekly producers) still uses it, and those genuinely place a single
 * member's rows. It is only the ADMIN pair path that was wrong for it.
 *
 * Capacity is rechecked inside the RPC, which is authoritative — generation can precede
 * approval by days. A 'capacity' outcome leaves that pair's review rows 'generated' and
 * re-approvable rather than marking it delivered. Member notification fires ONLY for a batch that
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

    // ── EDGE-ATOMIC MATERIALIZATION ────────────────────────────────────────────────────────────
    //
    // Approval no longer loops RECIPIENTS calling place_batch_rows. That path inserted ONE
    // direction per call while the RPC's eligibility gate is bidirectional, so once A's row
    // committed, B's call saw it and filtered A out — every edge collapsed to one side. The
    // production audit measured 145 live one-sided rows from exactly this, all with pair_id NULL,
    // and zero from the two-sided reciprocal path.
    //
    // Now: collapse the batch's symmetric review rows into UNDIRECTED pairs and call
    // materialize_admin_pair ONCE per pair. It writes both directions with one shared pair_id in
    // one transaction, under both participants' advisory locks, or writes nothing.
    //
    // Review rows are NOT pre-marked 'shown'. The RPC marks both proposal rows materialised only
    // when the pair actually lands, so a pair rejected for capacity or eligibility stays
    // 'generated' and remains reviewable — instead of being silently recorded as delivered.
    const now = new Date().toISOString()
    const { data: suggestions } = await adminClient
      .from('batch_suggestions')
      .select('recipient_id, suggested_id, match_score')
      .eq('batch_id', batchId)
      .eq('status', 'generated')

    const { pairs: rawPairs, unpaired } = toUndirectedPairs(suggestions ?? [])

    // Live visible-card counts, read ONCE so the order is fixed before the first call and a retry
    // reproduces it exactly. The RPC still rechecks capacity per edge and remains authoritative;
    // this only decides which edge gets the chance first.
    const { data: liveRows } = await adminClient
      .from('intro_requests')
      .select('requester_id, status')
      .eq('status', 'suggested')
    const visibleNow = new Map<string, number>()
    for (const r of liveRows ?? []) {
      if (!r?.requester_id) continue
      visibleNow.set(r.requester_id, (visibleNow.get(r.requester_id) ?? 0) + 1)
    }
    const scoreByPair = new Map<string, number>()
    for (const r of suggestions ?? []) {
      if (!r?.recipient_id || !r?.suggested_id) continue
      const k = r.recipient_id < r.suggested_id
        ? `${r.recipient_id}|${r.suggested_id}` : `${r.suggested_id}|${r.recipient_id}`
      scoreByPair.set(k, (scoreByPair.get(k) ?? 0) + Number(r.match_score ?? 0))
    }

    const pairs = canonicalApprovalOrder(rawPairs, {
      visibleCardsOf: (id) => visibleNow.get(id) ?? 0,
      scoreOf: (a, b) => scoreByPair.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0,
    })
    if (unpaired > 0) {
      // A proposal without its mirror cannot be materialised two-sidedly. Report the count; never
      // approve it one-sidedly.
      console.warn(`[approve-batch] ${unpaired} review row(s) had no symmetric mirror and were skipped`)
    }

    // Capacity can change between generation and approval; the RPC recheck is authoritative.
    const byOutcome: Record<string, number> = {}
    let createdVisible = 0
    let createdReserved = 0
    // Stamped BEFORE any pair is materialised: committed-card verification counts from here.
    const approvalStartedAt = new Date()
    const placedMembers = new Map<string, { visible: number; reserved: number; batchId: string | null }>()

    for (const pair of pairs) {
      const r = await materializeAdminPair(adminClient, {
        reviewBatchId: batchId, memberA: pair.a, memberB: pair.b,
      })
      byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1
      if (r.outcome !== 'created') continue
      if (r.tier === 'suggested') createdVisible++; else createdReserved++
      for (const [mid, bid] of [[pair.a, r.batchIdLo], [pair.b, r.batchIdHi]] as const) {
        const cur = placedMembers.get(mid) ?? { visible: 0, reserved: 0, batchId: null }
        if (r.tier === 'suggested') cur.visible++; else cur.reserved++
        // lo/hi follow canonical id order, so map each member to the batch that is actually theirs
        cur.batchId = pair.a < pair.b
          ? (mid === pair.a ? r.batchIdLo ?? null : r.batchIdHi ?? null)
          : (mid === pair.a ? r.batchIdHi ?? null : r.batchIdLo ?? null)
        placedMembers.set(mid, cur)
      }
    }

    // ── FINALIZE THE WEEKLY RELEASE (migration 074) ────────────────────────────────────────────
    //
    // Reaching this line means the loop ran to completion over every planned pair — a route that
    // threw mid-loop never arrives, so an interrupted approval can never be finalized.
    //
    // WHAT BLOCKS FINALIZATION. Any transient/system error. A batch where some pairs succeeded and
    // others failed transiently is NOT a completed release: the plan did not run cleanly, and the
    // honest response is to leave the week unreleased and let the admin retry. Approval is
    // idempotent (materialize_admin_pair refuses duplicates), so a retry re-materialises what is
    // missing, reaches the end again, and finalizes.
    //
    // WHAT DOES NOT BLOCK IT. Deterministic refusals — capacity, cooldown, blocked, ineligible,
    // invalid, duplicate_proposal, exists_active. Those are normal outcomes of a curated network;
    // treating them as failures would mean almost no batch could ever be released.
    //
    // The RPC derives the week, verifies committed cards and inserts the immutable fact in ONE
    // transaction. It supplies no count, so nothing here can fabricate a release.
    const transientFailures = byOutcome['error'] ?? 0
    let releaseFinalization: { status: string; releaseKey?: string; wasExisting?: boolean }
    if (transientFailures > 0) {
      releaseFinalization = { status: 'skipped_transient_errors' }
      console.log('[approve-batch] release NOT finalized: transient errors present; retry approval')
    } else {
      const fin = await finalizeWeeklyRelease(adminClient, { source: 'admin_approval', batchId })
      releaseFinalization = fin.finalized
        ? { status: fin.wasExisting ? 'already_finalized' : 'finalized', releaseKey: fin.releaseKey, wasExisting: fin.wasExisting }
        : { status: fin.reason }
      console.log('[approve-batch] release finalization:', releaseFinalization.status)
    }

    const placed = Array.from(placedMembers.entries()).map(([recipientId, v]) => ({
      recipientId,
      visible: v.visible,
      reserved: v.reserved,
      activeBatchId: v.visible > 0 ? v.batchId : null,
      queuedBatchId: v.reserved > 0 ? v.batchId : null,
    }))
    const rejected = Object.entries(byOutcome)
      .filter(([o]) => o !== 'created' && o !== 'already_materialized')
      .flatMap(([o, n]) => Array.from({ length: n }, () => ({ recipientId: '', reason: o })))

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
      if (p.visible > 0 && p.activeBatchId) {
        // Something actually landed on the member's screen → announce exactly that count. A batch
        // that ALSO reserved rows is still announced once, for its visible part only.
        await notifyAdminBatchReady(p.recipientId, p.activeBatchId, p.visible)
        batchVisible++; newBatchEmailsSent++
      } else if (p.reserved > 0 && p.queuedBatchId) {
        // Reserved only — the member must not be told about cards they cannot see.
        const unresolved = await countUnresolvedRecommendations(adminClient, p.recipientId)
        if (unresolved > 0) {
          actionNeeded++
          const r = await notifyPendingIntrosActionNeeded(p.recipientId, p.queuedBatchId, cycleKey)
          if (r.alreadyHandled) remindersAlreadyHandled++
          else if (r.emailed || r.skipped) actionNeededEmailsSent++
          else emailFailures++
        } else {
          otherSkipped++
        }
      } else {
        otherSkipped++
      }
    }

    console.log(`[approve-batch] cycle ${cycleKey}: placed=${placed.length} rejected=${rejected.length} | ${batchVisible} visible, ${actionNeeded} action-needed, ${otherSkipped} other-skipped | emails: ${newBatchEmailsSent} new-batch, ${actionNeededEmailsSent} action-needed, ${remindersAlreadyHandled} already-handled (dedup), ${emailFailures} failed`)
    if (rejected.length > 0) {
      // Reason CLASSES only. The recipient ids stay out of the log and out of the response: an
      // operator can re-derive them from the batch, and a log line is the wrong place for identities.
      const byReason = rejected.reduce<Record<string, number>>((acc, r) => {
        acc[r.reason] = (acc[r.reason] ?? 0) + 1
        return acc
      }, {})
      console.warn('[approve-batch] rejected recipients by reason:', JSON.stringify(byReason))
    }

    return NextResponse.json({
      success: true,
      cycleKey,
      pairsConsidered: pairs.length,
      pairsUnpaired: unpaired,
      releaseFinalization,
      pairsCreatedVisible: createdVisible,
      pairsCreatedReserved: createdReserved,
      // Aggregate outcome census — counts only, never a member identity.
      outcomes: byOutcome,
      placed: placed.length,
      rejected: rejected.length,
      rejectedByReason: rejected.reduce<Record<string, number>>((acc, r) => {
        acc[r.reason] = (acc[r.reason] ?? 0) + 1
        return acc
      }, {}),
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
