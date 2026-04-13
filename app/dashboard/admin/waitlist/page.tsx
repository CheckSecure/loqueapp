import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import AdminWaitlistClient from '@/components/AdminWaitlistClient'

export const metadata = { title: 'Waitlist | Admin' }

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export default async function AdminWaitlistPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  const { data: waitlist } = await supabase
    .from('waitlist')
    .select('*')
    .order('created_at', { ascending: false })

  const counts = {
    pending: waitlist?.filter(w => w.status === 'pending').length || 0,
    approved: waitlist?.filter(w => w.status === 'approved').length || 0,
    invited: waitlist?.filter(w => w.status === 'invited').length || 0,
    declined: waitlist?.filter(w => w.status === 'declined').length || 0,
  }

  return <AdminWaitlistClient waitlist={waitlist || []} counts={counts} />
}
