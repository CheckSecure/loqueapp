'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Users, MessageSquare, Calendar, UserCircle, LogOut, CreditCard, ShieldCheck, Settings, Network, Sparkles } from 'lucide-react'
import NotificationBell from './NotificationBell'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { useState, useRef, useEffect } from 'react'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

const navItems = [
  { href: '/dashboard/introductions', label: 'Introductions', icon: Users },
  { href: '/dashboard/opportunities', label: 'Opportunities', icon: Sparkles },
  { href: '/dashboard/network',       label: 'Network',       icon: Network },
  { href: '/dashboard/messages', label: 'Messages', icon: MessageSquare },
  { href: '/dashboard/meetings', label: 'Meetings', icon: Calendar },
  { href: '/dashboard/profile', label: 'Profile', icon: UserCircle },
  { href: '/dashboard/billing', label: 'Billing', icon: CreditCard },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
]

interface SidebarProps {
  displayName: string
  email: string
  initials: string
  avatarColor: string
  avatarUrl?: string | null
  credits: number
  unreadCount: number
  networkNotifCount: number
  meetingNotifCount: number
  opportunityBadgeCount: number
  adminBadgeCount: number
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
      ? 'text-red-300'
      : credits < 5
      ? 'text-amber-300'
      : 'text-brand-gold'

  const label =
    credits === 0
      ? 'No credits remaining'
      : `✦ ${credits} credit${credits === 1 ? '' : 's'}`

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={cn(
          'text-sm font-bold tracking-tight hover:opacity-80 transition-opacity',
          chipStyle
        )}
      >
        {label}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-60 bg-white border border-slate-200 rounded-xl shadow-2xl p-3.5 z-50">
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
  unreadCount,
  networkNotifCount,
  meetingNotifCount,
  opportunityBadgeCount,
  adminBadgeCount,
}: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()

  const [isAdmin, setIsAdmin] = useState(false)

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(({ data: { user } }) => {
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
    <aside className="hidden md:flex flex-col w-64 bg-[#0A1530] shrink-0 border-r border-white/5">
      {/* Brand mark — premium private-network treatment */}
      <div className="px-6 py-7 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-xl font-bold text-white tracking-tight">Andrel</span>
          <span className="text-[9px] uppercase tracking-[0.2em] text-brand-gold font-bold">Private</span>
        </div>
        <NotificationBell />
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-5 space-y-0.5 overflow-y-auto">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          const isMessages = href === '/dashboard/messages'
          const isNetwork = href === '/dashboard/network'
          const isMeetings = href === '/dashboard/meetings'
          const isOpportunities = href === '/dashboard/opportunities'
          const badgeCount = isMessages ? unreadCount : isNetwork ? networkNotifCount : isMeetings ? meetingNotifCount : isOpportunities ? opportunityBadgeCount : 0

          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'group relative flex items-center gap-3 pl-4 pr-3 py-2.5 rounded-lg text-sm font-medium transition-all',
                active
                  ? 'bg-white/[0.07] text-white'
                  : 'text-white/55 hover:bg-white/[0.04] hover:text-white/90'
              )}
            >
              {active && <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-r-full bg-brand-gold" />}
              <Icon className={cn('w-4 h-4 flex-shrink-0', active ? 'text-brand-gold' : 'text-white/45 group-hover:text-white/70')} />
              <span className="tracking-tight">{label}</span>
              {badgeCount > 0 && (
                <span className="ml-auto min-w-[20px] h-5 px-1.5 bg-brand-gold text-[#0A1530] text-[10px] font-bold rounded-full flex items-center justify-center">
                  {badgeCount > 9 ? '9+' : badgeCount}
                </span>
              )}
            </Link>
          )
        })}

        {isAdmin && (
          <Link
            href="/dashboard/admin"
            className={cn(
              'group relative flex items-center gap-3 pl-4 pr-3 py-2.5 rounded-lg text-sm font-medium transition-all',
              pathname.startsWith('/dashboard/admin')
                ? 'bg-white/[0.07] text-white'
                : 'text-white/55 hover:bg-white/[0.04] hover:text-white/90'
            )}
          >
            {pathname.startsWith('/dashboard/admin') && <span className="absolute left-0 top-2 bottom-2 w-[2px] rounded-r-full bg-brand-gold" />}
            <ShieldCheck className={cn('w-4 h-4 flex-shrink-0', pathname.startsWith('/dashboard/admin') ? 'text-brand-gold' : 'text-white/45 group-hover:text-white/70')} />
            <span className="tracking-tight">Admin</span>
            {adminBadgeCount > 0 && (
              <span className="ml-auto min-w-[20px] h-5 px-1.5 bg-brand-gold text-[#0A1530] text-[10px] font-bold rounded-full flex items-center justify-center">
                {adminBadgeCount > 9 ? '9+' : adminBadgeCount}
              </span>
            )}
          </Link>
        )}
      </nav>

      {/* Membership card + identity + sign out */}
      <div className="px-4 pb-5 pt-4 border-t border-white/5 space-y-4">
        {/* Premium membership card */}
        <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-[#162449] via-[#0F1C3A] to-[#0A1530] border border-white/10 p-4 shadow-inner">
          <div className="absolute top-0 left-3 right-3 h-px bg-gradient-to-r from-transparent via-brand-gold/80 to-transparent" />
          <div className="absolute -top-10 -right-10 w-24 h-24 bg-brand-gold/15 rounded-full blur-2xl pointer-events-none" />
          <div className="relative">
            <p className="text-[9px] uppercase tracking-[0.2em] text-brand-gold font-bold">Membership</p>
            <div className="mt-2.5 flex items-baseline justify-between gap-3">
              <CreditsChip credits={credits} />
              <Link
                href="/dashboard/billing"
                className="text-[11px] font-semibold text-brand-gold/80 hover:text-white transition-colors"
              >
                Upgrade →
              </Link>
            </div>
          </div>
        </div>

        {/* Identity */}
        <div className="flex items-center gap-3 px-1">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={displayName}
              className="w-9 h-9 rounded-full object-cover flex-shrink-0 ring-2 ring-brand-gold/30"
            />
          ) : (
            <div className={`w-9 h-9 rounded-full ${avatarColor} flex items-center justify-center text-white text-xs font-bold flex-shrink-0 ring-2 ring-brand-gold/30`}>
              {initials}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-white truncate">{displayName}</p>
            <p className="text-[10px] text-white/40 truncate">{email}</p>
          </div>
        </div>

        {/* Sign out */}
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-white/45 hover:text-white hover:bg-white/[0.05] rounded-lg transition-colors"
        >
          <LogOut className="w-3.5 h-3.5" />
          Sign out
        </button>
      </div>
    </aside>
  )
}
