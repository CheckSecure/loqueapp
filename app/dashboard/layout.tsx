import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Sidebar from '@/components/Sidebar'

const AVATAR_COLORS = [
  'bg-violet-500','bg-emerald-500','bg-amber-500','bg-rose-500',
  'bg-cyan-500','bg-indigo-500','bg-pink-500','bg-teal-500',
]

function pickColor(id: string) {
  const n = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Ensure a profile row exists for this user
  await supabase.from('profiles').upsert(
    {
      id: user.id,
      full_name: user.user_metadata?.full_name ?? null,
      avatar_color: pickColor(user.id),
    },
    { onConflict: 'id', ignoreDuplicates: true }
  )

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, avatar_color')
    .eq('id', user.id)
    .single()

  const displayName = profile?.full_name || user.email?.split('@')[0] || 'You'
  const initials = displayName.split(' ').map((n: string) => n[0]).slice(0, 2).join('').toUpperCase()
  const avatarColor = profile?.avatar_color || 'bg-indigo-500'

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar displayName={displayName} email={user.email || ''} initials={initials} avatarColor={avatarColor} />
      <main className="flex-1 min-w-0 overflow-auto">
        {children}
      </main>
    </div>
  )
}
