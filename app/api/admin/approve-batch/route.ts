import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import { sendNewBatchEmail } from '@/lib/email'
import { enqueueBatch } from '@/lib/introductions/queue'

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
 * and materialized_at is stamped. Notifications fire only for recipients actually
 * placed (active or queued).
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
    const placed: { recipientId: string; state: string; count: number }[] = []
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
        if (result.placed) placed.push({ recipientId, state: result.state ?? 'queued', count: result.count ?? ordered.length })
        else rejected.push({ recipientId, reason: result.reason ?? 'not_placed' })
      } catch (err: any) {
        console.error('[approve-batch] materialize failed for', recipientId, err?.message)
        rejected.push({ recipientId, reason: 'error' })
      }
    }

    // Notify only recipients whose recommendations were actually placed.
    const recipientProfiles = placed.length > 0
      ? (await adminClient.from('profiles').select('id, full_name, email').in('id', placed.map((p) => p.recipientId))).data
      : []
    const profileMap = new Map((recipientProfiles || []).map((p) => [p.id, p]))

    let emailsAttempted = 0
    for (const p of placed) {
      await createNotificationSafe({ userId: p.recipientId, type: 'new_batch' })
      const profile = profileMap.get(p.recipientId)
      if (profile?.email) {
        try {
          await sendNewBatchEmail(profile.email, profile.full_name || 'there', p.count)
          emailsAttempted++
        } catch (err) {
          console.error('[approve-batch] sendNewBatchEmail failed for', p.recipientId, err)
        }
      }
    }

    console.log(`[approve-batch] materialized: ${placed.length} placed, ${rejected.length} rejected; ${emailsAttempted} email attempts`)
    if (rejected.length > 0) {
      console.warn('[approve-batch] rejected recipients (already had a queued admin batch or no candidates):', JSON.stringify(rejected))
    }

    return NextResponse.json({
      success: true,
      placed: placed.length,
      rejected: rejected.length,
      rejectedDetail: rejected,
      emailsAttempted,
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
