import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== 'bizdev91@gmail.com') {
    return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
  }

  const { suggestionId } = await req.json()
  const adminClient = createAdminClient()
  await adminClient.from('batch_suggestions').delete().eq('id', suggestionId)
  return NextResponse.json({ success: true })
}

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== 'bizdev91@gmail.com') {
    return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
  }

  const { batchId, recipientId, suggestedId } = await req.json()
  const adminClient = createAdminClient()

  // Get profiles for reason generation
  const { data: profiles } = await adminClient
    .from('profiles')
    .select('id, full_name, role_type, intro_preferences, interests, mentorship_role, seniority, subscription_tier')
    .in('id', [recipientId, suggestedId])

  const recipient = profiles?.find(p => p.id === recipientId)
  const candidate = profiles?.find(p => p.id === suggestedId)

  const { error } = await adminClient.from('batch_suggestions').insert({
    batch_id: batchId,
    recipient_id: recipientId,
    suggested_id: suggestedId,
    reason: 'Manually added by Andrel team.',
    match_score: 100,
    position: 99,
    status: 'active',
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
