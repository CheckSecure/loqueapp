import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createNotificationSafe } from '@/lib/notifications'

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

    // Fire new_batch notification to every user with suggestions in this batch.
    // Dedupe by recipient_id since a user may have multiple suggestions.
    const { data: approvedSuggestions } = await adminClient
      .from('batch_suggestions')
      .select('recipient_id')
      .eq('batch_id', batchId)
      .eq('status', 'shown')

    const recipientIds = Array.from(new Set((approvedSuggestions || []).map(s => s.recipient_id).filter(Boolean)))

    for (const recipientId of recipientIds) {
      await createNotificationSafe({
        userId: recipientId,
        type: 'new_batch'
      })
    }

    console.log('[approve-batch] Fired new_batch notifications to ' + recipientIds.length + ' users')

    return NextResponse.json({ success: true, notifiedUsers: recipientIds.length })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
