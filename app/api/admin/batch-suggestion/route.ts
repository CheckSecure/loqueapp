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

  const { batchId, recipientId, suggestedId } = await req.json()
  if (!batchId || !recipientId || !suggestedId) {
    return NextResponse.json({ error: 'batchId, recipientId and suggestedId are required' }, { status: 400 })
  }
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

  // Duplicate prevention — never suggest the same pair twice in one batch.
  const { data: existing } = await adminClient
    .from('batch_suggestions')
    .select('id')
    .eq('batch_id', batchId)
    .eq('recipient_id', recipientId)
    .eq('suggested_id', suggestedId)
    .maybeSingle()
  if (existing) {
    return NextResponse.json({ error: 'This introduction already exists in the batch' }, { status: 409 })
  }

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
