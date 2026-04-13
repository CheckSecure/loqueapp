import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AdminIntrosClient from '@/components/AdminIntrosClient'

export const metadata = { title: 'Intro Requests | Admin' }

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export default async function AdminIntrosPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  const { data: introRequests } = await supabase
    .from('intro_requests')
    .select(`
      id,
      status,
      note,
      created_at,
      requester:profiles!requester_id(id, full_name, email, company, title, subscription_tier),
      target:profiles!target_user_id(id, full_name, email, company, title, subscription_tier)
    `)
    .order('created_at', { ascending: false })

  return <AdminIntrosClient introRequests={introRequests || []} />
}
