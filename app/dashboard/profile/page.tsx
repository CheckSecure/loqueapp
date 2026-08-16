import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import ProfileForm from '@/components/ProfileForm'
import MatchProfileCompletionCard from '@/components/MatchProfileCompletionCard'

export const metadata = { title: 'Profile | Andrel' }

export default async function ProfilePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // A3: server-component self read via service_role, scoped to the caller's own id (base SELECT revoked).
  const { data: profile } = await createAdminClient()
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="max-w-content-narrow mx-auto w-full">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Profile</h1>
          <p className="text-slate-500 text-sm mt-0.5">How you appear to other professionals on Andrel.</p>
        </div>
        <MatchProfileCompletionCard profile={profile} />
        <ProfileForm profile={profile} email={user.email || ''} />
      </div>
    </div>
  )
}
