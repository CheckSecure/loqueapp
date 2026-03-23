import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ProfileForm from '@/components/ProfileForm'

export const metadata = { title: 'Profile | Andrel' }

export default async function ProfilePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()

  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="max-w-2xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Profile</h1>
          <p className="text-slate-500 text-sm mt-0.5">How you appear to other professionals on Andrel.</p>
        </div>
        <ProfileForm profile={profile} email={user.email || ''} />
      </div>
    </div>
  )
}
