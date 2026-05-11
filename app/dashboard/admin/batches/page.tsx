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

      const { count: memberCount } = await adminClient
        .from('batch_suggestions')
        .select('recipient_id', { count: 'exact', head: true })
        .eq('batch_id', batch.id)

      return {
        ...batch,
        suggestion_count: count || 0,
        member_count: memberCount || 0
      }
    })
  )

  return <AdminBatchesClient batches={batchesWithCounts} />
}
