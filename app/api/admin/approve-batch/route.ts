import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

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

    // Notify all members of new batch
    const { createNotificationsForAllUsers } = await import('@/lib/notifications')
    await createNotificationsForAllUsers(
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
