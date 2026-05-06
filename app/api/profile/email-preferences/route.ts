import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function PATCH(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (typeof body.email_notifications_enabled !== 'boolean') {
    return NextResponse.json({ error: 'Invalid value' }, { status: 400 })
  }

  const { error } = await supabase
    .from('profiles')
    .update({ email_notifications_enabled: body.email_notifications_enabled })
    .eq('id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
