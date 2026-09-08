import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getAdminUser } from '@/lib/admin/getAdminUser'
import { createSupportMatch, isSupportConnected } from '@/lib/relationships/supportMatch'
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

  // ── Match + conversation, via public.create_support_match ────────────────────────────────────
  // PHASE 3 STAGE 1b. Replying to an issue report is the second of exactly two SANCTIONED
  // cross-community relationships: support must reach every member regardless of community. The
  // exemption is granted by the SQL function on profiles.is_admin = TRUE, read FOR SHARE in the
  // same transaction as the write — not by this route, and not by ADMIN_EMAIL (which gates who may
  // CALL this route, a separate and pre-existing question).
  //
  // BOTH ORIGINAL SCENARIOS ARE PRESERVED, and collapse into one call:
  //   (a) the welcome flow already created a match  -> 'already_matched', existing ids returned;
  //   (b) the reporter predates the welcome flow    -> 'created', both rows in one transaction.
  // The old code answered each with its own SELECT-then-INSERT pair, which could interleave with a
  // concurrent welcome and produce a match with no conversation. It cannot now.
  const support = await createSupportMatch(adminClient, adminUser.id, report.user_id, 'issue_reply')

  if (!isSupportConnected(support.outcome) || !support.matchId || !support.conversationId) {
    // FAIL CLOSED: the issue report is not linked to a conversation and its status is not flipped,
    // so the report stays visibly unanswered rather than being marked in-progress with nowhere for
    // the member to read a reply.
    console.error('[issues/reply] support match failed:', support.outcome, support.detail)
    return NextResponse.json({ error: 'Could not open a support conversation' }, { status: 500 })
  }

  const conversationId = support.conversationId

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
