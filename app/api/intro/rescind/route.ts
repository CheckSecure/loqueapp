import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertSameOrigin } from '@/lib/http/sameOrigin'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const crossOrigin = assertSameOrigin(req)
  if (crossOrigin) return crossOrigin
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const { targetId } = await req.json()

    // Browser DML on intro_requests is revoked (migration 055); write as service_role, scoped to the
    // caller's OWN outbound rows (requester_id = user.id) so this can only withdraw the viewer's own
    // expressed interest.
    const admin = createAdminClient()

    // Withdraw removes ONLY the viewer's expression of interest — never the
    // recommendation itself. Scope the delete to the expressed-interest statuses
    // so the underlying 'suggested' recommendation row survives (and reappears as a
    // suggestion), and so a 'queued', 'passed', 'archived', or 'hidden_permanent'
    // row is never destroyed.
    const { data, error } = await admin
      .from('intro_requests')
      .delete()
      .eq('requester_id', user.id)
      .eq('target_user_id', targetId)
      .in('status', ['pending', 'approved'])
      .select()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    // Archived-recommendation edge case: if this pair's recommendation was archived
    // when its batch completed (status 'archived' + batch_id), that row would keep
    // the pair SOFT-excluded from future recommendations — effectively permanent
    // while the exhaustion valve is off (lib/introRequests/history.ts). Withdrawing
    // must not permanently exclude the person. Neutralize it by clearing batch_id,
    // which reclassifies the row as a non-history ARTIFACT (archived + no batch_id →
    // not excluded). This does NOT delete the row and does NOT touch
    // recommendation_batches / promoteIfResolved / batch completion: the row stays
    // 'archived' (never rendered), so the visible-suggestion cap is unaffected and
    // no old batch is restored. Best-effort — never fails the withdrawal.
    const { error: neutralizeErr } = await admin
      .from('intro_requests')
      .update({ batch_id: null, updated_at: new Date().toISOString() })
      .eq('requester_id', user.id)
      .eq('target_user_id', targetId)
      .eq('status', 'archived')
      .not('batch_id', 'is', null)
    if (neutralizeErr) {
      console.error('[intro/rescind] archived neutralize failed (non-fatal):', neutralizeErr.message)
    }

    return NextResponse.json({ success: true, deleted: data?.length || 0 })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
