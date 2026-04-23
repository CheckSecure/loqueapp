import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

export async function POST(request: Request) {
  const supabase = createClient()
  const adminClient = createAdminClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { notificationId, markAll } = await request.json()

    if (markAll) {
      // Mark all notifications as read
      const { error } = await adminClient
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('user_id', user.id)
        .is('read_at', null)

      if (error) throw error

      return NextResponse.json({ success: true, message: 'All notifications marked as read' })
    } else if (notificationId) {
      // Mark single notification as read
      const { error } = await adminClient
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', notificationId)
        .eq('user_id', user.id) // Security: only mark own notifications

      if (error) throw error

      return NextResponse.json({ success: true })
    } else {
      return NextResponse.json({ error: 'Missing notificationId or markAll' }, { status: 400 })
    }
  } catch (error: any) {
    console.error('[Notifications Read] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
