import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import pool from '@/lib/db'

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

  const color = pickColor(user.id)
  const metaName = user.user_metadata?.full_name as string ?? null

  // Upsert profile in Replit PostgreSQL
  await pool.query(
    `INSERT INTO profiles (id, full_name, avatar_color)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [user.id, metaName, color]
  )

  const { rows } = await pool.query(
    'SELECT full_name, avatar_color FROM profiles WHERE id = $1',
    [user.id]
  )
  const profile = rows[0]

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
