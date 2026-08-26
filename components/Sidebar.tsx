'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Users, MessageSquare, Calendar, UserCircle, LogOut, CreditCard, ShieldCheck, Settings, Network, Sparkles } from 'lucide-react'
import NotificationBell from './NotificationBell'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { useState, useEffect } from 'react'
import { LOGO_ARIA_LABEL } from '@/lib/nav/logoHref'

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
  credits: number | null
  unreadCount: number
  networkNotifCount: number
  meetingNotifCount: number
  opportunityBadgeCount: number
  adminBadgeCount: number
  /** Resolved on the server by app/dashboard/layout.tsx — never derived in the browser. */
  logoHref: string
}

function CreditsChip({ credits }: { credits: number | null }) {
  // null = the balance failed to load (NOT zero). Never render "No credits remaining" for a load error.
  const chipStyle =
    credits === null
      ? 'text-slate-400'
      : credits === 0
      ? 'text-red-300'
      : credits < 5
      ? 'text-amber-300'
      : 'text-brand-gold'

  const label =
    credits === null
      ? 'Credits unavailable'
      : credits === 0
      ? 'No credits remaining'
      : `✦ ${credits} credit${credits === 1 ? '' : 's'}`

  return (
    <Link
      href="/dashboard/billing#credits"
      className={cn(
        'text-sm font-bold tracking-tight hover:opacity-80 transition-opacity',
        chipStyle
      )}
    >
      {label}
    </Link>
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
  logoHref,
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
    <aside className="hidden md:flex flex-col w-64 h-full min-h-0 bg-[#0A1530] shrink-0 border-r border-white/5">
      {/* Brand mark — premium private-network treatment */}
      <div className="shrink-0 px-6 py-7 border-b border-white/5 flex items-center justify-between">
        <div className="flex items-baseline gap-2 min-w-0">
          {/* Destination resolved on the server (app/dashboard/layout.tsx) and passed in, so this
              client component never asks Supabase who the viewer is just to render a link. */}
          <Link
            href={logoHref}
            aria-label={LOGO_ARIA_LABEL}
            className="text-xl font-bold text-white tracking-tight truncate rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A1530]"
          >
            Andrel
          </Link>
        </div>
        <NotificationBell />
      </div>

      {/* Navigation */}
      <nav className="flex-1 min-h-0 px-3 py-5 space-y-0.5 overflow-y-auto">
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
      <div className="shrink-0 px-4 pb-5 pt-4 border-t border-white/5 space-y-4">
        {/* Premium membership card */}
        <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-[#162449] via-[#0F1C3A] to-[#0A1530] border border-brand-gold/15 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ring-1 ring-white/5">
          <div className="absolute top-0 left-3 right-3 h-px bg-gradient-to-r from-transparent via-brand-gold to-transparent" />
          <div className="absolute -top-10 -right-10 w-28 h-28 bg-brand-gold/15 rounded-full blur-2xl pointer-events-none" aria-hidden="true" />
          <div className="absolute -bottom-12 -left-8 w-20 h-20 bg-brand-gold/8 rounded-full blur-2xl pointer-events-none" aria-hidden="true" />
          <div className="relative">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="block w-1 h-1 rounded-full bg-brand-gold" aria-hidden="true" />
              <p className="text-[9px] uppercase tracking-[0.22em] text-brand-gold font-bold">Membership</p>
            </div>
            <div className="mt-3 flex items-baseline justify-between gap-3">
              <CreditsChip credits={credits} />
              <Link
                href="/dashboard/billing"
                className="text-[11px] font-semibold text-brand-gold/80 hover:text-brand-gold transition-colors"
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
