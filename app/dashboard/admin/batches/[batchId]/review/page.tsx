import { createClient } from '@/lib/supabase/server'
import { professionalIdentityLine } from '@/lib/professionalIdentity'
import { communityOf, MEMBER_TYPE_COLUMNS, MEMBER_TYPES } from '@/lib/community/memberType'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import SuggestionRow from '@/components/admin/SuggestionRow'
import BatchActionsBar from '@/components/admin/BatchActionsBar'

export const metadata = { title: 'Batch Review | Admin' }
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export default async function BatchReviewPage({ params }: { params: { batchId: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  const admin = createAdminClient()

  const batchResult = await admin
    .from('introduction_batches')
    .select('*')
    .eq('id', params.batchId)
    .single()

  if (!batchResult.data) notFound()
  const batch = batchResult.data

  const suggestionsResult = await admin
    .from('batch_suggestions')
    .select('*')
    .eq('batch_id', params.batchId)
    .order('recipient_id', { ascending: true })
    .order('position', { ascending: true })

  const suggestions = suggestionsResult.data || []

  const userIds = new Set<string>()
  for (const s of suggestions) {
    if (s.recipient_id) userIds.add(s.recipient_id)
    if (s.suggested_id) userIds.add(s.suggested_id)
  }

  const profilesResult = await admin
    .from('profiles')
    .select(`id, full_name, email, title, company, role_type, subscription_tier, ${MEMBER_TYPE_COLUMNS}`)
    .in('id', Array.from(userIds))

  const profileMap = new Map<string, any>()
  for (const p of profilesResult.data || []) {
    profileMap.set(p.id, p)
  }

  const grouped = new Map<string, any[]>()
  for (const s of suggestions) {
    if (!s.recipient_id) continue
    if (!grouped.has(s.recipient_id)) grouped.set(s.recipient_id, [])
    grouped.get(s.recipient_id)!.push(s)
  }

  const recipientIds = Array.from(grouped.keys())
  recipientIds.sort((a, b) => {
    const nameA = profileMap.get(a)?.full_name || ''
    const nameB = profileMap.get(b)?.full_name || ''
    return nameA.localeCompare(nameB)
  })

  const totalGenerated = suggestions.filter((s: any) => s.status === 'generated').length
  const totalDropped = suggestions.filter((s: any) => s.status === 'dropped').length

  // ── COMMUNITY VISIBILITY (Phase 3 Stage 2B) ─────────────────────────────────────────────────
  // One batch deliberately holds the Professional and Next results, computed independently
  // (app/api/admin/generate-batch). Approval is still ONE lifecycle over that one batch — nothing
  // here splits it or changes what approval does. This only lets a reviewer see which community
  // each recipient group belongs to.
  //
  // communityOf returns null rather than guessing, so a row with an unreadable member_type renders
  // as "Unknown" and is counted separately. Labelling it Professional would be the one genuinely
  // dangerous thing this page could do.
  const COMMUNITY_LABEL: Record<string, string> = { professional: 'Professional', next: 'Next' }
  const labelFor = (profile: any) => COMMUNITY_LABEL[communityOf(profile) ?? ''] ?? 'Unknown'
  const recipientsByCommunity = new Map<string, number>()
  for (const rid of Array.from(grouped.keys())) {
    const label = labelFor(profileMap.get(rid))
    recipientsByCommunity.set(label, (recipientsByCommunity.get(label) ?? 0) + 1)
  }
  // Stable order: the known communities first, then Unknown if any row needs it. A
  // Professional-only batch therefore reads exactly as it does today, with one extra clause.
  const communityBreakdown = [...MEMBER_TYPES.map((t) => COMMUNITY_LABEL[t]), 'Unknown']
    .filter((label) => (recipientsByCommunity.get(label) ?? 0) > 0)
    .map((label) => `${recipientsByCommunity.get(label)} ${label}`)
    .join(', ')

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <Link
          href="/dashboard/admin/batches"
          className="text-sm text-slate-500 hover:text-slate-700 inline-flex items-center gap-1"
        >
          <ArrowLeft className="w-4 h-4" />
          Batches
        </Link>

        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Review Batch #{batch.batch_number}
          </h1>
          <p className="text-sm text-slate-500 mt-2">
            {recipientIds.length} recipients, {totalGenerated} active suggestions
            {totalDropped > 0 ? `, ${totalDropped} dropped` : ''}.
            {communityBreakdown ? ` (${communityBreakdown})` : ''}
          </p>
        </div>

        <BatchActionsBar batchId={params.batchId} droppedCount={totalDropped} />

        {recipientIds.length === 0 ? (
          <div className="bg-white rounded-2xl border border-slate-100 p-12 text-center">
            <p className="text-base font-semibold text-slate-900">No suggestions in this batch</p>
          </div>
        ) : (
          <div className="space-y-4">
            {recipientIds.map((rid) => {
              const recipient = profileMap.get(rid)
              const items = grouped.get(rid) || []
              const activeCount = items.filter((it: any) => it.status === 'generated').length
              const droppedCount = items.filter((it: any) => it.status === 'dropped').length

              return (
                <div key={rid} className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
                  <div className="px-6 py-4 border-b border-slate-100 bg-slate-50">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900 truncate">
                          {recipient?.full_name || 'Unknown'}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5 truncate">
                          {labelFor(recipient)} · {professionalIdentityLine(recipient)}
                          {recipient?.subscription_tier ? ` · ${recipient.subscription_tier}` : ''}
                        </p>
                      </div>
                      <p className="text-xs text-slate-500 flex-shrink-0">
                        {activeCount} suggestions{droppedCount > 0 ? ` (${droppedCount} dropped)` : ''}
                      </p>
                    </div>
                  </div>

                  <div className="divide-y divide-slate-100">
                    {items.map((item: any, idx: number) => (
                      <SuggestionRow
                        key={item.id}
                        suggestion={item}
                        suggested={profileMap.get(item.suggested_id) || null}
                        index={idx}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
