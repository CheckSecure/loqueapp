'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import Link from 'next/link'

const FAQ = [
  {
    category: 'Getting Started',
    items: [
      {
        q: 'What is Andrel?',
        a: 'Andrel is an invite-only professional network built on trust and intentional introductions. Every member is vetted, every connection is curated — designed for professionals who value depth over volume.',
      },
      {
        q: 'How do I get invited?',
        a: 'Andrel is invitation-only. You can apply to join the waitlist at andrel.app, and our team reviews applications on a rolling basis. Existing members may also nominate people they trust.',
      },
      {
        q: 'How does the onboarding work?',
        a: 'Once invited, you\'ll receive an email with a temporary password. You\'ll set a permanent password, complete your profile, and tell us who you\'re looking to meet. The whole process takes about three minutes.',
      },
    ],
  },
  {
    category: 'Introductions',
    items: [
      {
        q: 'How does the introduction system work?',
        a: 'Each week, Andrel surfaces a curated set of members aligned with your goals and background. You can express interest in anyone in your batch. When there is strong mutual alignment, we facilitate the introduction — connecting you through a shared conversation thread.',
      },
      {
        q: 'How are matches chosen?',
        a: 'Matches are based on your role, industry, stated goals, and who you\'re looking to meet. The number of introductions you receive each week is based on your membership level. We prioritize quality over volume — every introduction is intentional.',
      },
      {
        q: 'Can I request a specific introduction?',
        a: 'Andrel does not support direct connection requests. Instead, you can express interest in members you\'re introduced to, and we factor that signal into future curation. This keeps the experience high-trust and free from the noise of unsolicited outreach.',
      },
      {
        q: 'What happens after an introduction is facilitated?',
        a: 'Once an introduction is made, a conversation thread opens in your Messages. From there, it\'s up to you — schedule a call, explore a collaboration, or simply exchange ideas.',
      },
      {
        q: 'What if I\'m not interested in someone?',
        a: 'You can pass on any introduction. Profiles you pass on will not reappear in your batch immediately, and you have the option to mark someone as "Do not show again" if you prefer never to see them resurface.',
      },
    ],
  },
  {
    category: 'Credits & Billing',
    items: [
      {
        q: 'What are credits?',
        a: 'Credits are used when an introduction is successfully facilitated — not when you express interest. You are only charged when a mutual connection is made. New members receive 3 free credits to start.',
      },
      {
        q: 'How do I get more credits?',
        a: 'Your credits refill at the start of each month. You can also purchase additional credits from the Billing section of your dashboard.',
      },
      {
        q: 'Do unused credits roll over?',
        a: 'Credits top up each month rather than stack. This keeps the network active and ensures introductions remain intentional.',
      },
    ],
  },
  {
    category: 'Privacy & Trust',
    items: [
      {
        q: 'Who can see my profile?',
        a: 'Your profile is only visible to other verified Andrel members through curated introductions. There is no public browsing, no profile view tracking, and no exposure to non-members.',
      },
      {
        q: 'Can I control who I\'m matched with?',
        a: 'Yes. Your intro preferences — set during onboarding and editable in your profile — guide every match. You also choose whether to express interest in each introduction you receive.',
      },
      {
        q: 'How do I delete my account?',
        a: 'You can delete your account at any time from Settings → Danger Zone. This permanently removes your profile, matches, and messages. If you change your mind, you would need to reapply to join.',
      },
    ],
  },
]

function AccordionItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-b border-slate-100 last:border-0">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-4 px-6 py-4 text-left hover:bg-slate-50 transition-colors"
      >
        <span className="text-sm font-semibold text-slate-900">{q}</span>
        <ChevronDown className={cn('w-4 h-4 text-slate-400 flex-shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-6 pb-4">
          <p className="text-sm text-slate-500 leading-relaxed">{a}</p>
        </div>
      )}
    </div>
  )
}

export default function FAQPage() {
  return (
    <div className="min-h-screen bg-[#F5F6FB] px-4 py-16">
      <div className="max-w-2xl mx-auto">

        <div className="text-center mb-12">
          <Link href="/" className="text-xl font-bold text-[#1B2850] tracking-tight block mb-8">Andrel</Link>
          <h1 className="text-3xl font-bold text-slate-900 mb-3">Frequently Asked Questions</h1>
          <p className="text-slate-500 max-w-md mx-auto">Andrel is built for professionals who believe the right introduction can change everything.</p>
        </div>

        <div className="space-y-6">
          {FAQ.map(({ category, items }) => (
            <div key={category} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100">
                <h2 className="text-xs font-semibold text-[#1B2850] uppercase tracking-widest">{category}</h2>
              </div>
              {items.map(item => (
                <AccordionItem key={item.q} {...item} />
              ))}
            </div>
          ))}
        </div>

        <div className="mt-12 text-center">
          <p className="text-sm text-slate-500 mb-2">Still have questions?</p>
          <a href="mailto:support@andrel.app" className="text-sm font-semibold text-[#1B2850] hover:text-[#2E4080] transition-colors">
            Email us at support@andrel.app →
          </a>
        </div>

      </div>
    </div>
  )
}
