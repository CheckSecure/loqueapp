import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import AdminBatchesClient from '@/components/AdminBatchesClient'

export const metadata = { title: 'Batch Management | Admin' }

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export default async function AdminBatchesPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  const adminClient = createAdminClient()

  const { data: batches } = await adminClient
    .from('introduction_batches')
    .select('*')
    .order('created_at', { ascending: false })

  const batchesWithCounts = await Promise.all(
    (batches || []).map(async (batch) => {
      const { count } = await adminClient
        .from('batch_suggestions')
        .select('id', { count: 'exact', head: true })
        .eq('batch_id', batch.id)

      // The unit a reviewer decides on is an undirected PAIR, and the optimizer emits two
      // symmetric rows for each one. Counting rows would report every introduction twice, and
      // counting recipient_id with count:'exact' counts ROWS, not distinct members — so both of
      // the old numbers overstated the batch. Derive both honestly from the actual rows.
      const { data: edgeRows } = await adminClient
        .from('batch_suggestions')
        .select('recipient_id, suggested_id')
        .eq('batch_id', batch.id)

      const pairKeys = new Set<string>()
      const members = new Set<string>()
      for (const r of edgeRows || []) {
        if (!r?.recipient_id || !r?.suggested_id) continue
        members.add(r.recipient_id)
        pairKeys.add(r.recipient_id < r.suggested_id
          ? `${r.recipient_id}|${r.suggested_id}`
          : `${r.suggested_id}|${r.recipient_id}`)
      }

      return {
        ...batch,
        suggestion_count: count || 0,   // directed rows, retained for diagnostics
        pair_count: pairKeys.size,      // introductions — what a reviewer actually approves
        member_count: members.size      // DISTINCT members, not row count
      }
    })
  )

  return <AdminBatchesClient batches={batchesWithCounts} />
}
