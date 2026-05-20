import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const VALID_COLUMNS = new Set([
  'email_new_introductions',
  'email_messages',
  'email_meeting_updates',
  'email_opportunities',
  'email_product_updates',
  'email_daily_digest',
])

export async function PATCH(req: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const updates: Record<string, boolean> = {}
  for (const [key, val] of Object.entries(body)) {
    if (!VALID_COLUMNS.has(key) || typeof val !== 'boolean') {
      return NextResponse.json({ error: `Invalid field: ${key}` }, { status: 400 })
    }
    updates[key] = val
  }
  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields provided' }, { status: 400 })
  }

  const { error } = await supabase
    .from('notification_preferences')
    .upsert({ user_id: user.id, ...updates, updated_at: new Date().toISOString() })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
