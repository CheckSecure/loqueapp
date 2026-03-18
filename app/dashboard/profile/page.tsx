import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ProfileForm from '@/components/ProfileForm'
import pool from '@/lib/db'

export const metadata = { title: 'Profile | Cadre' }

export default async function ProfilePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { rows } = await pool.query(
    'SELECT * FROM profiles WHERE id = $1',
    [user.id]
  )
  const profile = rows[0] || null

  return (
    <div className="p-6 md:p-8 pt-20 md:pt-8">
      <div className="max-w-2xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Profile</h1>
          <p className="text-slate-500 text-sm mt-0.5">How you appear to other professionals on Cadre.</p>
        </div>
        <ProfileForm profile={profile} email={user.email || ''} />
      </div>
    </div>
  )
}
