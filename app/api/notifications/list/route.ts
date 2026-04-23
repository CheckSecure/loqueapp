import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const supabase = createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const limit = parseInt(searchParams.get('limit') || '50')
  const unreadOnly = searchParams.get('unread') === 'true'

  try {
    let query = supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (unreadOnly) {
      query = query.is('read_at', null)
    }

    const { data: notifications, error } = await query

    if (error) throw error

    return NextResponse.json({
      notifications: notifications || [],
      count: notifications?.length || 0
    })
  } catch (error: any) {
    console.error('[Notifications List] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
