import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = createClient()
  
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const { count, error } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('read', false)

    if (error) throw error

    return NextResponse.json({ count: count || 0 })
  } catch (error: any) {
    console.error('[Notifications Unread Count] Error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
