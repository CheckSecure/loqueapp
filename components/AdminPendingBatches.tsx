import { createClient } from '@/lib/supabase/server'
import AdminBatchReview from './AdminBatchReview'

export default async function AdminPendingBatches() {
  const supabase = createClient()

  const { data: pendingBatches } = await supabase
    .from('introduction_batches')
    .select('id, batch_number, week_start, week_end, status')
    .eq('status', 'pending_review')
    .order('created_at', { ascending: false })

  if (!pendingBatches || pendingBatches.length === 0) return null

  const batchesWithGroups = await Promise.all(
    pendingBatches.map(async (batch) => {
      const { data: suggestions } = await supabase
        .from('batch_suggestions')
        .select('id, recipient_id, suggested_id, reason, match_score')
        .eq('batch_id', batch.id)
        .eq('status', 'active')

      const recipientIds = [...new Set((suggestions ?? []).map((s: any) => s.recipient_id))]
      const suggestedIds = [...new Set((suggestions ?? []).map((s: any) => s.suggested_id))]
      const allIds = [...new Set([...recipientIds, ...suggestedIds])]

      const { data: profileRows } = await supabase
        .from('profiles')
        .select('id, full_name, title, company, role_type')
        .in('id', allIds)

      const profileMap: Record<string, any> = {}
      for (const p of profileRows ?? []) profileMap[p.id] = p

      const groups: Record<string, any> = {}
      for (const s of suggestions ?? []) {
        if (!groups[s.recipient_id]) {
          const rp = profileMap[s.recipient_id] ?? {}
          groups[s.recipient_id] = {
            recipient_id: s.recipient_id,
            recipient_name: rp.full_name ?? 'Unknown',
            recipient_role: rp.role_type ?? '',
            suggestions: [],
          }
        }
        groups[s.recipient_id].suggestions.push({
          id: s.id,
          suggested_id: s.suggested_id,
          reason: s.reason,
          match_score: s.match_score,
          suggested_profile: profileMap[s.suggested_id] ?? {},
        })
      }

      return {
        ...batch,
        groups: Object.values(groups),
      }
    })
  )

  return (
    <div className="mt-4 space-y-4">
      {batchesWithGroups.map((batch) => (
        <AdminBatchReview key={batch.id} batch={batch} />
      ))}
    </div>
  )
}
