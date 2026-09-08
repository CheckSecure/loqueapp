import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { NextResponse } from 'next/server'
import { sendMatchCreatedEmail } from '@/lib/email'
import { deductCredits, hasEnoughCredits } from '@/lib/credits'
import { requireAdmin } from '@/lib/admin/requireAdmin'
import { createGatedMatch, isConnected } from '@/lib/relationships/gatedMatch'

export async function POST(request: Request) {
  const { error: authError } = await requireAdmin()
  if (authError) return authError

  const supabase = createClient()
  const adminSupabase = createAdminClient()
  const { requestId } = await request.json()

  if (!requestId) {
    return NextResponse.json({ error: 'Request ID required' }, { status: 400 })
  }

  // A3: admin route — read the intro + embedded participant profiles via service_role (the admin's
  // authenticated role no longer holds base SELECT on profiles once 058 is applied). Authorized above by requireAdmin().
  // ══════════════════════════════════════════════════════════════════════════════════════════
  // FAIL-CLOSED PENDING A PRODUCT DECISION.
  //
  // This route is a SECOND credit-debit authority, and it disagrees with the canonical one on both
  // WHO pays and WHAT is decremented:
  //
  //   this route     charges ONE member (whoever expressed interest first) and decrements `balance`
  //                  ALONE — leaving free_credits untouched, so the stored invariant
  //                  balance = free_credits + premium_credits is broken by every call.
  //   the delegate   charges BOTH members, decrements free_credits, and RECOMPUTES balance.
  //
  // Those are not two implementations of one rule; they are two different rules. Migration 072
  // cannot honestly be called the atomic credit authority while this route independently moves
  // balances, so it is disabled rather than quietly re-pointed at the new one.
  //
  // The product question this route cannot answer for itself: when an ADMINISTRATOR manually
  // facilitates an introduction between TWO ORDINARY MEMBERS, is that free, charged to one, or
  // charged to both? The code contains evidence for two different answers and none for which is
  // intended, so choosing here would be inventing policy inside a bug fix.
  //
  // While disabled this writes NOTHING: no match, no conversation, no debit, no ledger row.
  //
  // TO RE-ENABLE: decide the policy, then implement the debit deliberately. The MATCH write itself
  // now goes through public.create_gated_match (Phase 3 Stage 1b) — see below — which is atomic and
  // community-gated but charges nothing, so re-enabling this route does NOT silently reinstate any
  // credit behaviour. Never a second balance update.
  //
  // NOT finalize_mutual_match_atomic, which the earlier note here recommended: it requires an
  // 'approved'/'accepted' intro_requests row in EACH direction and charges BOTH members, so it
  // would both refuse this flow's actual inputs and answer the credit question by itself.
  //
  // The legacy body below is intentionally retained (and still type-checked) so the reviewed
  // behaviour is visible when the policy decision is made.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  const FACILITATION_ENABLED = false as boolean
  if (!FACILITATION_ENABLED) {
    return NextResponse.json(
      {
        error: 'Manual introduction facilitation is temporarily disabled.',
        message: 'This action is disabled pending a credit-policy decision. Nothing was changed and no credit was used.',
        code: 'FACILITATION_DISABLED_PENDING_POLICY',
      },
      { status: 501 },
    )
  }

  const { data: introRequest, error: reqError } = await createAdminClient()
    .from('intro_requests')
    .select('id, requester_id, target_user_id, created_at, requester:profiles!intro_requests_requester_id_fkey(id, full_name, email, role_type, company), target:profiles!intro_requests_target_user_id_fkey(id, full_name, email, role_type, company)')
    .eq('id', requestId)
    .single()

  if (reqError || !introRequest) {
    return NextResponse.json({ error: 'Request not found' }, { status: 404 })
  }

  // Check for mutual interest (reverse request exists)
  const { data: reverseRequest } = await supabase
    .from('intro_requests')
    .select('id, created_at')
    .eq('requester_id', introRequest.target_user_id)
    .eq('target_user_id', introRequest.requester_id)
    .eq('status', 'pending')
    .single()

  if (!reverseRequest) {
    return NextResponse.json({ error: 'Mutual interest required - both users must express interest first' }, { status: 400 })
  }

  // Determine who expressed interest first
  const firstRequestTime = new Date(introRequest.created_at)
  const reverseRequestTime = new Date(reverseRequest.created_at)
  const firstPersonId = firstRequestTime < reverseRequestTime ? introRequest.requester_id : introRequest.target_user_id

  // Check credit balance of first person
  const { data: creditRow } = await adminSupabase
    .from('meeting_credits')
    .select('free_credits, premium_credits, balance')
    .eq('user_id', firstPersonId)
    .single()

  const balance = creditRow?.balance ?? 0

  if (balance < 1) {
    return NextResponse.json({ error: 'Insufficient credits' }, { status: 400 })
  }

  // ── PHASE 3 STAGE 1b: match + conversation through public.create_gated_match ─────────────────
  // Previously two separate service-role INSERTs (matches, then conversations) that no RLS policy
  // could gate. The RPC takes both participant advisory locks, evaluates community_pair_allowed in
  // the same transaction as the write, and writes both rows together or neither — which also ends
  // the case where the conversation INSERT failed and left a match nobody could message through.
  //
  // SEMANTICS PRESERVED: still no credit debit (the debit was DELETED, see the note below, and
  // create_gated_match charges nothing); still no admin_facilitated flag and no admin_notes on this
  // path, exactly as the previous INSERT wrote them; column order (requester as user_a) unchanged.
  const gated = await createGatedMatch(adminSupabase, introRequest.requester_id, introRequest.target_user_id, {
    adminFacilitated: false,
  })

  if (gated.outcome === 'ineligible') {
    return NextResponse.json({
      error: 'These members belong to different Andrel communities and cannot be connected.',
      code: 'CROSS_COMMUNITY',
    }, { status: 409 })
  }
  if (!isConnected(gated.outcome) || !gated.matchId || !gated.conversationId) {
    // 'invalid' and 'error' both land here. FAIL CLOSED: no intro_requests update, no notification,
    // no email, and no direct-INSERT fallback.
    return NextResponse.json({ error: 'Failed to create match' }, { status: 500 })
  }
  const match = { id: gated.matchId }

  // ── THE CREDIT MUTATION WAS REMOVED, NOT JUST DISABLED ──────────────────────────────────────
  // It read:
  //     update({ balance: balance - 1 }).eq('user_id', firstPersonId)
  //     insert credit_transactions { amount: -1, type: 'deduction' }
  // and it was wrong twice over: it decremented `balance` ALONE (breaking
  // balance = free_credits + premium_credits on every call, since free_credits was left untouched),
  // and it charged only ONE member where the canonical delegate charges both.
  //
  // Leaving it here behind a flag would mean re-enabling this route is one boolean away from
  // reinstating a balance-only decrement. It is deleted so that whoever makes the product decision
  // has to write the correct implementation. create_gated_match below deliberately does NOT charge,
  // so the debit cannot come back by accident — only by someone writing it on purpose.

  // Update both intro_requests to approved
  await adminSupabase
    .from('intro_requests')
    .update({ status: 'approved', credit_charged: true })
    .in('id', [requestId, reverseRequest.id])

  const requester = introRequest.requester as any
  const target = introRequest.target as any

  // Send notifications
  const notifications = [
    {
      user_id: introRequest.requester_id,
      type: 'intro_accepted',
      title: 'New Connection',
      body: `You're now connected with ${target.full_name}`,
      link: '/dashboard/network',
    },
    {
      user_id: introRequest.target_user_id,
      type: 'intro_accepted',
      title: 'New Connection',
      body: `You're now connected with ${requester.full_name}`,
      link: '/dashboard/network',
    },
  ]

  await adminSupabase.from('notifications').insert(notifications)

  // Send emails
  try {
    await Promise.all([
      sendMatchCreatedEmail(
        requester.email,
        requester.full_name,
        target.full_name,
        target.role_type,
        target.company
      ),
      sendMatchCreatedEmail(
        target.email,
        target.full_name,
        requester.full_name,
        requester.role_type,
        requester.company
      ),
    ])
  } catch (emailError) {
    console.error('Failed to send match emails:', emailError)
  }

  return NextResponse.json({ success: true, match })
}
