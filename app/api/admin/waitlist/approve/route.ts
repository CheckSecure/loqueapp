import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { logRecommendationEvent } from '@/lib/analytics/recommendationEvents'
import { isBlockedTransition, invalidTransitionMessage } from '@/lib/referrals/statusTransitions'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { entryId } = await request.json()

  // Enforce the lifecycle server-side (mirrors the UI): only pending → approved.
  const { data: current } = await supabase.from('waitlist').select('status').eq('id', entryId).maybeSingle()
  if (!current) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })
  if (isBlockedTransition(current.status, 'approved')) {
    return NextResponse.json({ error: invalidTransitionMessage(current.status, 'approved') }, { status: 409 })
  }

  const { error } = await supabase
    .from('waitlist')
    .update({ status: 'approved' })
    .eq('id', entryId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  logRecommendationEvent('recommendation_approved', { entryId })

  revalidatePath('/dashboard', 'layout')
  return NextResponse.json({ success: true })
}
