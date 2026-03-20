'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Users, MessageSquare, Calendar, UserCircle, LogOut, CreditCard, ShieldCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { useState, useRef, useEffect } from 'react'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

const navItems = [
  { href: '/dashboard/introductions', label: 'Introductions', icon: Users },
  { href: '/dashboard/messages', label: 'Messages', icon: MessageSquare },
  { href: '/dashboard/meetings', label: 'Meetings', icon: Calendar },
  { href: '/dashboard/profile', label: 'Profile', icon: UserCircle },
  { href: '/dashboard/billing', label: 'Billing', icon: CreditCard },
]

interface SidebarProps {
  displayName: string
  email: string
  initials: string
  avatarColor: string
  avatarUrl?: string | null
  credits: number
}

function CreditsChip({ credits }: { credits: number }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const chipStyle =
    credits === 0
      ? 'bg-red-50 text-red-600 border-red-200'
      : credits < 5
      ? 'bg-amber-50 text-amber-600 border-amber-200'
      : 'bg-[#FDF3E3] text-[#C4922A] border-[#e8c88a]'

  const label =
    credits === 0
      ? 'No credits remaining'
      : `✦ ${credits} credit${credits === 1 ? '' : 's'}`

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-semibold hover:opacity-80 transition-opacity',
          chipStyle
        )}
      >
        {label}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-60 bg-white border border-slate-200 rounded-xl shadow-lg p-3.5 z-50">
          <p className="text-xs font-semibold text-slate-800 mb-1">Meeting credits</p>
          <p className="text-xs text-slate-500 leading-relaxed">
            Credits are used to request meetings. Purchase more credits to continue connecting.
          </p>
          {credits < 5 && (
            <p className={cn('text-xs font-medium mt-2', credits === 0 ? 'text-red-600' : 'text-amber-600')}>
              {credits === 0 ? 'You have no credits left.' : `Only ${credits} credit${credits === 1 ? '' : 's'} remaining.`}
            </p>
          )}
          <div className="mt-3 pt-2.5 border-t border-slate-100">
            <Link href="/dashboard/billing" className="text-xs font-semibold text-[#1B2850] hover:text-[#2E4080] transition-colors">
              Purchase credits →
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Sidebar({
  displayName,
  email,
  initials,
  avatarColor,
  avatarUrl,
  credits,
}: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()

  // Verify admin status directly against the live Supabase session.
  // Start as false so non-admins never see a flash of the link.
  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
      console.log('Sidebar auth check - email:', user?.email)
      console.log('Sidebar isAdmin result:', user?.email === ADMIN_EMAIL)
      setIsAdmin(user?.email === ADMIN_EMAIL)
    })
  }, [])

  const handleLogout = async () => {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/')
    router.refresh()
  }

  return (
    <aside className="hidden md:flex flex-col w-60 bg-white border-r border-slate-200 shrink-0">
      <div className="px-5 py-6 border-b border-slate-200">
        <span className="text-lg font-bold text-[#1B2850] tracking-tight">Loque</span>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                active ? 'bg-[#1B2850] text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              )}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {label}
            </Link>
          )
        })}

        {isAdmin && (
          <Link href="/dashboard/admin">Admin</Link>
        )}
      </nav>
      <div className="px-3 pb-4 border-t border-slate-200 pt-4 space-y-3">
        <div className="px-2 flex items-center justify-between">
          <CreditsChip credits={credits} />
          <Link
            href="/dashboard/billing"
            className="text-xs font-semibold text-[#C4922A] hover:text-[#b07d24] transition-colors"
          >
            Upgrade
          </Link>
        </div>
        <div className="flex items-center gap-3 px-2">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={displayName}
              className="w-8 h-8 rounded-full object-cover flex-shrink-0"
            />
          ) : (
            <div className={`w-8 h-8 rounded-full ${avatarColor} flex items-center justify-center text-white text-xs font-bold flex-shrink-0`}>
              {initials}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-slate-900 truncate">{displayName}</p>
            <p className="text-xs text-slate-400 truncate">{email}</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Sign out
        </button>
      </div>
    </aside>
  )
}
