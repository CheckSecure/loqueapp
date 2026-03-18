'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Users, MessageSquare, Calendar, UserCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useState, useRef, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { LogOut } from 'lucide-react'

const bottomNavItems = [
  { href: '/dashboard/introductions', label: 'Intros', icon: Users },
  { href: '/dashboard/messages', label: 'Messages', icon: MessageSquare },
  { href: '/dashboard/meetings', label: 'Meetings', icon: Calendar },
  { href: '/dashboard/profile', label: 'Profile', icon: UserCircle },
]

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

  const label = credits === 0 ? 'No credits' : `✦ ${credits}`

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className={cn('px-2.5 py-1 rounded-full border text-xs font-semibold', chipStyle)}
      >
        {label}
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-2 w-56 bg-white border border-slate-200 rounded-xl shadow-lg p-3.5 z-50">
          <p className="text-xs font-semibold text-slate-800 mb-1">Meeting credits</p>
          <p className="text-xs text-slate-500 leading-relaxed">
            Credits are used to request meetings. Purchase more to continue connecting.
          </p>
          {credits < 5 && (
            <p className={cn('text-xs font-medium mt-2', credits === 0 ? 'text-red-600' : 'text-amber-600')}>
              {credits === 0 ? 'No credits left.' : `Only ${credits} remaining.`}
            </p>
          )}
          <div className="mt-3 pt-2.5 border-t border-slate-100">
            <button className="text-xs font-semibold text-[#1B2850]">Purchase credits →</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function MobileNav({ credits, unreadCount = 0 }: { credits: number; unreadCount?: number }) {
  const pathname = usePathname()

  return (
    <>
      {/* Top header — mobile only */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-50 bg-white border-b border-slate-200 px-4 h-14 flex items-center justify-between">
        <span className="text-lg font-bold text-[#1B2850] tracking-tight">Cadre</span>
        <CreditsChip credits={credits} />
      </div>

      {/* Bottom nav — mobile only */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-slate-200 flex h-16">
        {bottomNavItems.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          const isMessages = href === '/dashboard/messages'
          const showBadge = isMessages && unreadCount > 0
          return (
            <Link
              key={href}
              href={href}
              className="flex-1 flex flex-col items-center justify-center gap-0.5 relative py-2"
            >
              {active && (
                <span className="absolute top-0 left-3 right-3 h-0.5 rounded-full bg-[#C4922A]" />
              )}
              <span className="relative inline-flex">
                <Icon className={cn('w-5 h-5', active ? 'text-[#C4922A]' : 'text-slate-400')} />
                {showBadge && (
                  <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-0.5 leading-none">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </span>
              <span className={cn('text-[10px] font-medium', active ? 'text-[#C4922A]' : 'text-slate-400')}>
                {label}
              </span>
            </Link>
          )
        })}
      </nav>
    </>
  )
}
