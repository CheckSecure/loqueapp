import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'

/**
 * Permanently hide one of the caller's OWN batch suggestions.
 *
 * ─── WHY THIS WRITES AS service_role (Phase 3 Stage 1b) ───────────────────────────────────────
 * This used to issue the UPDATE with the member's SESSION client, which meant the write only
 * worked because `authenticated` still held UPDATE on public.batch_suggestions plus a permissive
 * "Users can update their own batch suggestions" policy. That grant is reachable from the browser
 * console with the shipped anon key — the same class of surface migration 055 closed for messages,
 * meetings, matches, conversations, intro_requests, credit_transactions and profiles, and the only
 * core table it missed.
 *
 * Migration 097 revokes that grant. This route is the one legitimate consumer, so it moves to the
 * pattern 055 established: authorize the caller HERE with getUser(), then perform the write as
 * service_role. The route becomes the boundary instead of the policy.
 *
 * ─── THE OWNERSHIP FILTER IS NOT OPTIONAL ─────────────────────────────────────────────────────
 * service_role bypasses RLS, so `.eq('recipient_id', user.id)` is no longer defence in depth
 * behind a policy — it is the ONLY thing standing between a caller and another member's row. Both
 * predicates are required and both are server-derived: `rowId` is the client's, `user.id` never
 * is. A row id belonging to someone else matches zero rows and changes nothing.
 *
 * (This is the same defect class the 2026-05-11 audit found in the old `passOnSuggestion`, which
 * accepted a rowId and updated by id alone. That function has since moved to intro_requests and
 * carries its own `.eq('requester_id', user.id)`; it is not a batch_suggestions writer any more,
 * so this route is the only browser-originated write to the table.)
 */
export async function POST(req: Request) {
  try {
    const { rowId } = await req.json()

    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Reject a missing/non-string id before it reaches the query, so a null can never widen the
    // filter to "every row whose recipient is me".
    if (!rowId || typeof rowId !== 'string') {
      return NextResponse.json({ error: 'rowId required' }, { status: 400 })
    }

    // Authorized above; written as service_role because migration 097 removed the browser's
    // UPDATE privilege on this table. Scoped by BOTH the row id and the caller's own id.
    const { error } = await createAdminClient()
      .from('batch_suggestions')
      .update({ status: 'hidden_permanent' })
      .eq('id', rowId)
      .eq('recipient_id', user.id) // Security: only hide your own suggestions

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Hide suggestion error:', error)
    return NextResponse.json({ error: 'Failed to hide suggestion' }, { status: 500 })
  }
}
