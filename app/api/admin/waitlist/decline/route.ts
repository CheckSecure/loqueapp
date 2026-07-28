import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { isBlockedTransition, invalidTransitionMessage } from '@/lib/referrals/statusTransitions'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { entryId } = await request.json()

  // Enforce the lifecycle server-side: decline only from pending / approved / contacted.
  const { data: current } = await supabase.from('waitlist').select('status').eq('id', entryId).maybeSingle()
  if (!current) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  if (isBlockedTransition(current.status, 'declined')) {
    return NextResponse.json({ error: invalidTransitionMessage(current.status, 'declined') }, { status: 409 })
  }

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

  revalidatePath('/dashboard', 'layout')
  return NextResponse.json({ success: true })
}
