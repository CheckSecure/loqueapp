import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import AdminIntrosClient from '@/components/AdminIntrosClient'
import { bucketIntroRecords } from '@/lib/introRequests/classify'

export const metadata = { title: 'Intro Requests | Admin' }
// Admin-only + never publicly cached (renders operational member data).
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export default async function AdminIntrosPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  // Service-role reads (RLS never silent-zeros admin-only aggregates). One intro_requests read +
  // one matches read → the pure classifier buckets everything (no N+1, no per-row queries).
  const admin = createAdminClient()
  const [{ data: introRequests }, { data: matches }] = await Promise.all([
    admin
      .from('intro_requests')
      .select(`
        id, status, note, created_at, requester_id, target_user_id, pair_id, is_admin_initiated,
        requester:profiles!requester_id(id, full_name, email, company, title, subscription_tier),
        target:profiles!target_user_id(id, full_name, email, company, title, subscription_tier)
      `)
      .order('created_at', { ascending: false }),
    admin.from('matches').select('user_a_id, user_b_id').eq('status', 'active').is('removed_at', null),
  ])

  const bucketed = bucketIntroRecords((introRequests ?? []) as any, (matches ?? []) as any)
  return <AdminIntrosClient bucketed={bucketed} />
}
