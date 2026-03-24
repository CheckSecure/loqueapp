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
        a: 'Andrel is an invite-only professional network built on trust and warm introductions. Every member is vetted, and every connection is intentional — no cold outreach, no noise.',
      },
      {
        q: 'How do I get invited?',
        a: 'Andrel is invitation-only. You can apply to join the waitlist at andrel.app, and our team reviews applications on a rolling basis. Existing members may also nominate people they trust.',
      },
      {
        q: 'How does the onboarding work?',
        a: 'Once invited, you\'ll receive an email with a temporary password. You\'ll then set a permanent password, complete your profile, and tell us who you\'re looking to meet. The whole process takes about 3 minutes.',
      },
    ],
  },
  {
    category: 'Introductions',
    items: [
      {
        q: 'How does the introduction system work?',
        a: 'Each week, our system surfaces a curated set of members who match your goals and background. You can request an introduction to anyone in your batch. If they accept, you\'re connected and can start a conversation.',
      },
      {
        q: 'How are matches chosen?',
        a: 'Matches are based on your role, industry, stated goals, and who you\'re looking to meet. We prioritize quality over quantity — you\'ll see a small, thoughtful set of introductions each week rather than an overwhelming list.',
      },
      {
        q: 'What happens after I accept an introduction?',
        a: 'Once both parties accept, a conversation thread opens in your Messages. From there it\'s up to you — schedule a call, exchange ideas, or explore a collaboration.',
      },
    ],
  },
  {
    category: 'Credits & Billing',
    items: [
      {
        q: 'What are credits?',
        a: 'Credits are used to request introductions. Each introduction request costs 1 credit. New members receive 3 free credits, and your balance is topped back up to 3 at the start of each month.',
      },
      {
        q: 'How do I get more credits?',
        a: 'Your credits refill to 3 automatically on the 1st of each month. You can also purchase additional credits from the Billing section of your dashboard.',
      },
      {
        q: 'Do unused credits roll over?',
        a: 'Credits top up to 3 each month — they don\'t stack beyond that. If you have 2 credits remaining, you\'ll be topped up to 3, not 5. This keeps the network active and ensures introductions are used intentionally.',
      },
    ],
  },
  {
    category: 'Privacy & Trust',
    items: [
      {
        q: 'Who can see my profile?',
        a: 'Your profile is only visible to other verified Andrel members. We do not show your information to the public, search engines, or third parties.',
      },
      {
        q: 'Can I control who I\'m matched with?',
        a: 'Yes. Your intro preferences — set during onboarding and editable in your profile — guide who you\'re matched with. You also choose whether to accept or decline any introduction request.',
      },
      {
        q: 'How do I delete my account?',
        a: 'You can delete your account at any time from Settings → Danger Zone. This permanently removes your profile, matches, and messages. If you change your mind, you\'d need to reapply to join.',
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
          <p className="text-slate-500">Everything you need to know about Andrel.</p>
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
