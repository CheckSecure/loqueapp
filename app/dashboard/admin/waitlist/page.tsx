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
    .select(`
      id, full_name, email, company, title, role_type,
      linkedin_url, referral_source, status, created_at, invited_at,
      referrals!waitlist_id(
        referral_note, status,
        referrer:profiles!referrer_user_id(id, full_name, account_status)
      )
    `)
    .order('created_at', { ascending: false })

  // Hide referrals where the referrer is no longer active. Catches:
  //   - deactivated referrers (per V1 spec)
  //   - orphaned referral_source='referral' rows with no joined referral
  //   - referrer rows missing for any reason (stale data, FK issues)
  const visible = (waitlist ?? []).filter(w =>
    w.referral_source !== 'referral' ||
    (w.referrals as any[])?.[0]?.referrer?.account_status === 'active'
  )

  const counts = {
    pending:  visible.filter(w => w.status === 'pending').length,
    approved: visible.filter(w => w.status === 'approved').length,
    invited:  visible.filter(w => w.status === 'invited').length,
    declined: visible.filter(w => w.status === 'declined').length,
  }

  return <AdminWaitlistClient waitlist={visible} counts={counts} />
}
