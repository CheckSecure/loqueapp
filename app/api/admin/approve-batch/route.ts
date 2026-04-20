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

    // Notify all members of new batch
    // Notifications handled by weekly-refresh cron job
    // // await createNotificationSafe({ // Handled by weekly-refresh cron
      'new_batch',
      'Your introductions are ready',
      'Your curated introductions for this week are now available.',
      '/dashboard/introductions'
    )
    return NextResponse.json({ success: true })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
