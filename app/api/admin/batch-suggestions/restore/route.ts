import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * POST /api/admin/batch-suggestions/restore
 *
 * Restores a previously dropped batch_suggestion. Flips status back to
 * 'generated' and clears dropped_at. Per Phase 2 plan, restore fully
 * undoes the drop — no cooldown applies after restore.
 *
 * Also restores the reciprocal pair if it exists in the same batch and
 * is currently 'dropped'.
 *
 * Body: { suggestionId: string }
 * Returns: { success: true, restoredReciprocal: boolean }
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const userResult = await supabase.auth.getUser()
    const user = userResult.data.user
    if (!user || user.email !== ADMIN_EMAIL) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
    }

    const body = await req.json()
    const suggestionId = body?.suggestionId
    if (!suggestionId) {
      return NextResponse.json({ error: 'Missing suggestionId' }, { status: 400 })
    }

    const admin = createAdminClient()

    const lookup = await admin
      .from('batch_suggestions')
      .select('id, batch_id, recipient_id, suggested_id, status')
      .eq('id', suggestionId)
      .single()

    if (lookup.error || !lookup.data) {
      return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 })
    }

    const target = lookup.data
    if (target.status !== 'dropped') {
      return NextResponse.json({ error: 'Only dropped suggestions can be restored' }, { status: 400 })
    }

    const restoreResult = await admin
      .from('batch_suggestions')
      .update({ status: 'generated', dropped_at: null })
      .eq('id', suggestionId)
      .eq('status', 'dropped')

    if (restoreResult.error) {
      return NextResponse.json({ error: restoreResult.error.message }, { status: 500 })
    }

    let restoredReciprocal = false
    if (target.recipient_id && target.suggested_id && target.batch_id) {
      const reciprocalResult = await admin
        .from('batch_suggestions')
        .update({ status: 'generated', dropped_at: null })
        .eq('batch_id', target.batch_id)
        .eq('recipient_id', target.suggested_id)
        .eq('suggested_id', target.recipient_id)
        .eq('status', 'dropped')
        .select('id')

      if (!reciprocalResult.error && reciprocalResult.data && reciprocalResult.data.length > 0) {
        restoredReciprocal = true
      }
    }

    return NextResponse.json({ success: true, restoredReciprocal })
  } catch (err: any) {
    console.error('[restore] error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
