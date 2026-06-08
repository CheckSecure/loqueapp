import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import LaunchAnnouncementClient from '@/components/LaunchAnnouncementClient'

export const metadata = { title: 'Launch announcement | Admin' }
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export default async function LaunchAnnouncementPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  // Surface prior-send state so the operator can see if this has been fired
  // before. Service-role read is safe — admin auth gate above already enforced.
  const admin = createAdminClient()
  const { data: sentRows } = await admin
    .from('waitlist')
    .select('launch_announcement_sent_at')
    .not('launch_announcement_sent_at', 'is', null)
    .order('launch_announcement_sent_at', { ascending: false })
    .limit(1)

  const lastSentAt = sentRows?.[0]?.launch_announcement_sent_at ?? null

  const { count: sentCount } = await admin
    .from('waitlist')
    .select('id', { count: 'exact', head: true })
    .not('launch_announcement_sent_at', 'is', null)

  return (
    <LaunchAnnouncementClient
      lastSentAt={lastSentAt}
      sentCount={sentCount ?? 0}
    />
  )
}
