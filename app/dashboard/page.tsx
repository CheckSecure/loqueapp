import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import LogoutButton from '@/components/LogoutButton'
import { LayoutDashboard, Users, Settings, Bell } from 'lucide-react'

export const metadata = {
  title: 'Dashboard | Cadre',
}

export default async function DashboardPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const displayName = user.user_metadata?.full_name || user.email?.split('@')[0] || 'there'
  const initials = (user.user_metadata?.full_name as string)
    ?.split(' ')
    .map((n: string) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase() || user.email?.[0].toUpperCase() || 'U'

  const stats = [
    { label: 'Team Members', value: '1', change: 'Just you for now' },
    { label: 'Projects', value: '0', change: 'Create your first project' },
    { label: 'Tasks Open', value: '0', change: 'All caught up' },
  ]

  return (
    <div className="min-h-screen flex bg-gray-50">
      <aside className="hidden md:flex flex-col w-60 bg-white border-r border-gray-100 py-6 px-4">
        <div className="mb-8 px-2">
          <span className="text-lg font-bold text-cadre-600 tracking-tight">Cadre</span>
        </div>
        <nav className="flex-1 space-y-1">
          {[
            { icon: LayoutDashboard, label: 'Dashboard', active: true },
            { icon: Users, label: 'Team', active: false },
            { icon: Settings, label: 'Settings', active: false },
          ].map(({ icon: Icon, label, active }) => (
            <button
              key={label}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? 'bg-cadre-50 text-cadre-700'
                  : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </nav>
        <div className="pt-4 border-t border-gray-100">
          <div className="flex items-center gap-3 px-2 mb-3">
            <div className="w-8 h-8 rounded-full bg-cadre-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-900 truncate">{displayName}</p>
              <p className="text-xs text-gray-400 truncate">{user.email}</p>
            </div>
          </div>
          <LogoutButton />
        </div>
      </aside>

      <div className="flex-1 flex flex-col">
        <header className="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Dashboard</h1>
          </div>
          <div className="flex items-center gap-3">
            <button className="text-gray-400 hover:text-gray-600 transition-colors">
              <Bell className="w-5 h-5" />
            </button>
            <div className="w-8 h-8 rounded-full bg-cadre-600 flex items-center justify-center text-white text-xs font-bold md:hidden">
              {initials}
            </div>
          </div>
        </header>

        <main className="flex-1 p-6">
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-gray-900">
              Welcome back, {displayName} 👋
            </h2>
            <p className="text-gray-500 mt-1 text-sm">Here&apos;s what&apos;s happening with your workspace.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            {stats.map((stat) => (
              <div key={stat.label} className="bg-white border border-gray-100 rounded-xl p-5 shadow-sm">
                <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">{stat.label}</p>
                <p className="text-3xl font-bold text-gray-900 mt-1">{stat.value}</p>
                <p className="text-xs text-gray-400 mt-1">{stat.change}</p>
              </div>
            ))}
          </div>

          <div className="bg-white border border-gray-100 rounded-xl p-8 shadow-sm text-center">
            <div className="w-12 h-12 bg-cadre-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <LayoutDashboard className="w-6 h-6 text-cadre-600" />
            </div>
            <h3 className="text-base font-semibold text-gray-900 mb-1">Your workspace is ready</h3>
            <p className="text-sm text-gray-400 max-w-sm mx-auto">
              Invite your team and start your first project to get the most out of Cadre.
            </p>
            <button className="mt-5 bg-cadre-600 text-white text-sm font-semibold px-5 py-2 rounded-lg hover:bg-cadre-700 transition-colors">
              Invite team members
            </button>
          </div>
        </main>
      </div>
    </div>
  )
}
