import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * POST /api/admin/batch-suggestions/drop
 *
 * Marks a batch_suggestion as dropped. Also drops the reciprocal pair
 * (if it exists in the same batch and is currently 'generated').
 *
 * Body: { suggestionId: string }
 * Returns: { success: true, droppedReciprocal: boolean }
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
    if (target.status !== 'generated') {
      return NextResponse.json({ error: 'Only generated suggestions can be dropped' }, { status: 400 })
    }

    const now = new Date().toISOString()

    const dropResult = await admin
      .from('batch_suggestions')
      .update({ status: 'dropped', dropped_at: now })
      .eq('id', suggestionId)
      .eq('status', 'generated')

    if (dropResult.error) {
      return NextResponse.json({ error: dropResult.error.message }, { status: 500 })
    }

    let droppedReciprocal = false
    if (target.recipient_id && target.suggested_id && target.batch_id) {
      const reciprocalResult = await admin
        .from('batch_suggestions')
        .update({ status: 'dropped', dropped_at: now })
        .eq('batch_id', target.batch_id)
        .eq('recipient_id', target.suggested_id)
        .eq('suggested_id', target.recipient_id)
        .eq('status', 'generated')
        .select('id')

      if (!reciprocalResult.error && reciprocalResult.data && reciprocalResult.data.length > 0) {
        droppedReciprocal = true
      }
    }

    return NextResponse.json({ success: true, droppedReciprocal })
  } catch (err: any) {
    console.error('[drop] error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
