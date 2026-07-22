import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isEligibleMember, eligibilityExclusionReason, ELIGIBILITY_COLUMNS } from '@/lib/matching/eligibility'
import { isSameCompany } from '@/lib/matching/same-company'

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

  const { batchId, recipientId, suggestedId, oneWay } = await req.json()
  if (!batchId || !recipientId || !suggestedId) {
    return NextResponse.json({ error: 'batchId, recipientId and suggestedId are required' }, { status: 400 })
  }
  // Manual concierge introductions are RECIPROCAL by default — the same invariant the
  // graph generator guarantees. Adding Alexander ↔ Cathleen shows BOTH members the
  // other. An administrator can pass `oneWay: true` to deliberately override reciprocity
  // (e.g. a sponsored/targeted one-directional intro), which is the only supported way
  // to create a one-way edge in the system.
  const reciprocal = oneWay !== true
  const adminClient = createAdminClient()

  // No self-introductions.
  if (recipientId === suggestedId) {
    return NextResponse.json({ error: 'Cannot introduce a member to themselves' }, { status: 400 })
  }

  // Fetch both profiles (including eligibility columns) so a manual add honors the
  // SAME rules as algorithmic matching — a paused/test/admin/suspended/incomplete
  // member, or the admin's own account, can never be curated in either.
  const { data: profiles } = await adminClient
    .from('profiles')
    .select(`id, full_name, company, ${ELIGIBILITY_COLUMNS}`)
    .in('id', [recipientId, suggestedId])
  const recipient = profiles?.find(p => p.id === recipientId)
  const candidate = profiles?.find(p => p.id === suggestedId)

  if (!recipient || !candidate) {
    return NextResponse.json({ error: 'Recipient or candidate profile not found' }, { status: 404 })
  }
  if (!isEligibleMember(recipient)) {
    return NextResponse.json({ error: `Recipient is not eligible for introductions (${eligibilityExclusionReason(recipient)})` }, { status: 409 })
  }
  if (!isEligibleMember(candidate)) {
    return NextResponse.json({ error: `Candidate is not eligible to be suggested (${eligibilityExclusionReason(candidate)})` }, { status: 409 })
  }
  if (isSameCompany(recipient, candidate)) {
    return NextResponse.json({ error: 'Recipient and candidate are at the same company' }, { status: 409 })
  }

  // Duplicate prevention — never suggest the same pair twice in one batch. For a
  // reciprocal add, check BOTH directions so re-adding an existing mutual edge is a
  // no-op rather than a partial duplicate.
  const directions = reciprocal
    ? [{ recipient_id: recipientId, suggested_id: suggestedId }, { recipient_id: suggestedId, suggested_id: recipientId }]
    : [{ recipient_id: recipientId, suggested_id: suggestedId }]

  const { data: existing } = await adminClient
    .from('batch_suggestions')
    .select('recipient_id, suggested_id')
    .eq('batch_id', batchId)
    .in('recipient_id', [recipientId, suggestedId])
    .in('suggested_id', [recipientId, suggestedId])
  const existingKeys = new Set((existing || []).map(e => `${e.recipient_id}>${e.suggested_id}`))
  const toInsert = directions
    .filter(d => !existingKeys.has(`${d.recipient_id}>${d.suggested_id}`))
    .map(d => ({
      batch_id: batchId,
      recipient_id: d.recipient_id,
      suggested_id: d.suggested_id,
      reason: 'Manually added by Andrel team.',
      match_score: 100,
      position: 99,
      status: 'active' as const,
    }))

  if (toInsert.length === 0) {
    return NextResponse.json({ error: 'This introduction already exists in the batch' }, { status: 409 })
  }

  const { error } = await adminClient.from('batch_suggestions').insert(toInsert)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, reciprocal, inserted: toInsert.length })
}
