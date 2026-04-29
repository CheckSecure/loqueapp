import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { entryId } = await request.json()

  const { error } = await supabase
    .from('waitlist')
    .update({ status: 'declined' })
    .eq('id', entryId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Sync referrals table — no-op if this waitlist row has no referral.
  const adminClient = createAdminClient()
  await adminClient
    .from('referrals')
    .update({ status: 'rejected', rejected_at: new Date().toISOString() })
    .eq('waitlist_id', entryId)

  return NextResponse.json({ success: true })
}
