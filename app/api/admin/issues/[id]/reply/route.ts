import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getAdminUser } from '@/lib/admin/getAdminUser'
import { buildBidirectionalMatchFilter } from '@/lib/db/filters'
import { revalidatePath } from 'next/cache'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export async function POST(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const adminClient = createAdminClient()

  // Fetch the issue report
  const { data: report } = await adminClient
    .from('issue_reports')
    .select('id, user_id, status, conversation_id')
    .eq('id', params.id)
    .maybeSingle()

  if (!report) {
    return NextResponse.json({ error: 'Issue report not found' }, { status: 404 })
  }

  // Scenario (c): reporter profile no longer exists (orphan row after account deletion)
  const { data: reporterProfile } = await adminClient
    .from('profiles')
    .select('id')
    .eq('id', report.user_id)
    .maybeSingle()

  if (!reporterProfile) {
    return NextResponse.json({ error: 'Reporter account no longer exists' }, { status: 404 })
  }

  // Resolve admin user id
  const adminUser = await getAdminUser()
  if (!adminUser) {
    return NextResponse.json({ error: 'Admin user not resolvable' }, { status: 500 })
  }

  // Scenario (a): find existing match (welcome flow creates one for every onboarded user)
  // Scenario (b): no match exists — create one (reporter predates welcome flow)
  const { data: existingMatch } = await adminClient
    .from('matches')
    .select('id')
    .or(buildBidirectionalMatchFilter(adminUser.id, report.user_id))
    .maybeSingle()

  let matchId: string

  if (existingMatch) {
    // Scenario (a): reuse welcome match
    matchId = existingMatch.id
  } else {
    // Scenario (b): no match exists — create one
    const { data: newMatch, error: matchErr } = await adminClient
      .from('matches')
      .insert({
        user_a_id: adminUser.id,
        user_b_id: report.user_id,
        status: 'active',
        admin_facilitated: true,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (matchErr || !newMatch) {
      console.error('[issues/reply] match insert failed:', matchErr)
      return NextResponse.json({ error: `Match creation failed: ${matchErr?.message}` }, { status: 500 })
    }
    matchId = newMatch.id
  }

  // Find or create conversation for the match
  const { data: existingConv } = await adminClient
    .from('conversations')
    .select('id')
    .eq('match_id', matchId)
    .maybeSingle()

  let conversationId: string

  if (existingConv) {
    conversationId = existingConv.id
  } else {
    const { data: newConv, error: convErr } = await adminClient
      .from('conversations')
      .insert({ match_id: matchId })
      .select('id')
      .single()

    if (convErr || !newConv) {
      console.error('[issues/reply] conversation insert failed:', convErr)
      return NextResponse.json({ error: `Conversation creation failed: ${convErr?.message}` }, { status: 500 })
    }
    conversationId = newConv.id
  }

  // Status auto-flip: 'new' → 'in_progress'; any other status left unchanged
  const updates: Record<string, string> = { conversation_id: conversationId }
  if (report.status === 'new') {
    updates.status = 'in_progress'
  }

  await adminClient
    .from('issue_reports')
    .update(updates)
    .eq('id', params.id)

  revalidatePath('/dashboard', 'layout')
  console.log('[issues/reply] success', { reportId: params.id, conversationId, statusFlipped: report.status === 'new' })
  return NextResponse.json({ success: true, conversationId })
}
