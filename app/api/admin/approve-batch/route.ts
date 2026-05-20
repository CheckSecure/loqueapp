import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'
import { sendNewBatchEmail } from '@/lib/email'

export const dynamic = 'force-dynamic'

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

    // Mark any previous active batch as completed
    await adminClient
      .from('introduction_batches')
      .update({ status: 'completed' })
      .eq('status', 'active')

    // Approve this batch
    const { error } = await adminClient
      .from('introduction_batches')
      .update({ status: 'active' })
      .eq('id', batchId)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // CRITICAL: Mark all suggestions in this batch as 'shown' with timestamp
    // This ensures they won't be reused for 90 days
    const now = new Date().toISOString()
    await adminClient
      .from('batch_suggestions')
      .update({
        status: 'shown',
        shown_at: now
      })
      .eq('batch_id', batchId)
      .eq('status', 'generated')

    // Per-user counts for this batch (so the email can mention how many).
    const { data: approvedSuggestions } = await adminClient
      .from('batch_suggestions')
      .select('recipient_id')
      .eq('batch_id', batchId)
      .eq('status', 'shown')

    const recipientCounts = new Map<string, number>()
    for (const s of approvedSuggestions || []) {
      if (s.recipient_id) {
        recipientCounts.set(s.recipient_id, (recipientCounts.get(s.recipient_id) || 0) + 1)
      }
    }

    const recipientIds = Array.from(recipientCounts.keys())

    // Look up profile email + name for each recipient. The email function itself
    // checks the email_new_introductions preference and logs a suppression if off.
    const { data: recipientProfiles } = recipientIds.length > 0
      ? await adminClient
          .from('profiles')
          .select('id, full_name, email')
          .in('id', recipientIds)
      : { data: [] }

    const profileMap = new Map((recipientProfiles || []).map(p => [p.id, p]))

    let emailsAttempted = 0
    for (const recipientId of recipientIds) {
      await createNotificationSafe({
        userId: recipientId,
        type: 'new_batch'
      })

      const profile = profileMap.get(recipientId)
      if (profile?.email) {
        const count = recipientCounts.get(recipientId) || 0
        try {
          await sendNewBatchEmail(profile.email, profile.full_name || 'there', count)
          emailsAttempted++
        } catch (err) {
          console.error('[approve-batch] sendNewBatchEmail failed for', recipientId, err)
        }
      }
    }

    console.log(`[approve-batch] Fired new_batch notifications to ${recipientIds.length} users; ${emailsAttempted} email attempts (suppressed by preference are logged separately)`)

    return NextResponse.json({ success: true, notifiedUsers: recipientIds.length, emailsAttempted })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
