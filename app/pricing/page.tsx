'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Check, Zap, Shield, Star, CreditCard, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'

const FREE_FEATURES = [
  '3 credits on signup',
  'Weekly curated introductions',
  'Basic profile',
  'Messaging with your matches',
]

const PRO_FEATURES = [
  '15 credits added every month',
  'Priority matching algorithm',
  'Professional badge on profile',
  'Early access to new weekly batches',
  'Everything in Free',
]

const EXEC_FEATURES = [
  'Unlimited credits',
  'Priority matching algorithm',
  'Executive badge on profile',
  'Early access to new weekly batches',
  'Dedicated concierge introduction support',
  'Everything in Professional',
]

const CREDIT_PACKS = [
  { credits: 5,  price: 9,  label: 'Starter pack',  perCredit: '$1.80' },
  { credits: 15, price: 19, label: 'Best value',     perCredit: '$1.27', popular: true },
  { credits: 30, price: 35, label: 'Power pack',     perCredit: '$1.17' },
]

const FAQS = [
  {
    q: 'What are credits?',
    a: 'Credits are used to request meetings with other members. Each meeting request costs 1 credit.',
  },
  {
    q: 'Do credits roll over?',
    a: 'Subscription credits reset each month and do not roll over. Purchased credit packs never expire.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes, you can cancel your subscription at any time with no penalties.',
  },
  {
    q: 'What happens when I run out of credits?',
    a: 'You can purchase a credit top-up pack or upgrade your plan.',
  },
]

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false)
  return (
    <button
      onClick={() => setOpen(v => !v)}
      className="w-full text-left"
    >
      <div className="flex items-center justify-between py-4 border-b border-slate-100">
        <span className="text-sm font-semibold text-slate-900">{q}</span>
        {open
          ? <ChevronUp className="w-4 h-4 text-slate-400 flex-shrink-0" />
          : <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />
        }
      </div>
      {open && (
        <p className="text-sm text-slate-500 leading-relaxed pt-3 pb-4">{a}</p>
      )}
    </button>
  )
}

export default function PricingPage() {
  const [annual, setAnnual] = useState(false)

  const proPrice  = annual ? 39 : 49
  const execPrice = annual ? 79 : 99

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* Nav */}
      <nav className="sticky top-0 z-50 bg-white/80 backdrop-blur border-b border-slate-100">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-xl font-bold text-[#1B2850] tracking-tight">Andrel</Link>
          <div className="flex items-center gap-3">
            <Link href="/pricing" className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors px-3 py-1.5">
              Pricing
            </Link>
            <Link href="/login" className="text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors px-3 py-1.5">
              Sign in
            </Link>
            <Link href="/signup" className="text-sm font-semibold bg-[#1B2850] text-white px-4 py-2 rounded-lg hover:bg-[#2E4080] transition-colors">
              Join Andrel
            </Link>
          </div>
        </div>
      </nav>

      <main className="flex-1">
        {/* Hero */}
        <section className="max-w-5xl mx-auto px-6 pt-16 pb-10 text-center">
          <div className="inline-flex items-center gap-2 bg-[#FDF3E3] text-[#C4922A] text-xs font-semibold px-3 py-1.5 rounded-full mb-6 tracking-wide uppercase">
            Simple, transparent pricing
          </div>
          <h1 className="text-4xl sm:text-5xl font-extrabold text-slate-900 leading-tight tracking-tight mb-4">
            Invest in your network.<br />
            <span className="text-[#C4922A]">The right connections pay for themselves.</span>
          </h1>
          <p className="text-lg text-slate-500 max-w-xl mx-auto">
            Choose the plan that fits how you connect. Cancel or change anytime.
          </p>

          {/* Billing toggle */}
          <div className="inline-flex items-center gap-3 mt-8 bg-slate-100 rounded-xl p-1">
            <button
              onClick={() => setAnnual(false)}
              className={cn(
                'px-5 py-2 rounded-lg text-sm font-semibold transition-all',
                !annual ? 'bg-white text-[#1B2850] shadow-sm' : 'text-slate-500'
              )}
            >
              Monthly
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={cn(
                'flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-semibold transition-all',
                annual ? 'bg-white text-[#1B2850] shadow-sm' : 'text-slate-500'
              )}
            >
              Annual
              <span className="bg-[#C4922A] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">
                -20%
              </span>
            </button>
          </div>
        </section>

        {/* Pricing tiers */}
        <section className="max-w-5xl mx-auto px-6 pb-16">
          <div className="grid md:grid-cols-3 gap-6 items-stretch">

            {/* Free */}
            <div className="bg-white border border-slate-200 rounded-2xl p-7 flex flex-col">
              <div className="mb-6">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">Free</p>
                <div className="flex items-end gap-1">
                  <span className="text-4xl font-extrabold text-slate-900">$0</span>
                  <span className="text-slate-400 text-sm mb-1.5">/month</span>
                </div>
                <p className="text-xs text-slate-400 mt-1">Forever free · No credit card required</p>
              </div>
              <ul className="space-y-3 flex-1 mb-8">
                {FREE_FEATURES.map(f => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-slate-600">
                    <Check className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className="block text-center text-sm font-semibold text-[#1B2850] border border-[#1B2850] px-5 py-2.5 rounded-xl hover:bg-slate-50 transition-colors"
              >
                Get started
              </Link>
            </div>

            {/* Professional — Most Popular */}
            <div className="relative bg-white border-2 border-[#1B2850] rounded-2xl p-7 flex flex-col shadow-lg shadow-[#1B2850]/10">
              <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                <span className="inline-flex items-center gap-1.5 bg-[#C4922A] text-white text-xs font-bold px-3 py-1 rounded-full shadow">
                  <Star className="w-3 h-3" />
                  Most Popular
                </span>
              </div>
              <div className="mb-6">
                <p className="text-xs font-semibold text-[#1B2850] uppercase tracking-wide mb-1">Professional</p>
                <div className="flex items-end gap-1">
                  <span className="text-4xl font-extrabold text-slate-900">${proPrice}</span>
                  <span className="text-slate-400 text-sm mb-1.5">/month</span>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  {annual ? `$${proPrice * 12} billed annually · Cancel anytime` : 'Billed monthly · Cancel anytime'}
                </p>
              </div>
              <ul className="space-y-3 flex-1 mb-8">
                {PRO_FEATURES.map(f => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-slate-600">
                    <Check className="w-4 h-4 text-[#C4922A] flex-shrink-0 mt-0.5" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className="block text-center text-sm font-bold bg-[#1B2850] text-white px-5 py-2.5 rounded-xl hover:bg-[#2E4080] transition-colors"
              >
                Upgrade now
              </Link>
            </div>

            {/* Executive */}
            <div className="bg-gradient-to-br from-[#1B2850] to-[#2E4080] rounded-2xl p-7 flex flex-col">
              <div className="mb-6">
                <p className="text-xs font-semibold text-[#C4922A] uppercase tracking-wide mb-1">Executive</p>
                <div className="flex items-end gap-1">
                  <span className="text-4xl font-extrabold text-white">${execPrice}</span>
                  <span className="text-white/50 text-sm mb-1.5">/month</span>
                </div>
                <p className="text-xs text-white/40 mt-1">
                  {annual ? `$${execPrice * 12} billed annually · Cancel anytime` : 'Billed monthly · Cancel anytime'}
                </p>
              </div>
              <ul className="space-y-3 flex-1 mb-8">
                {EXEC_FEATURES.map(f => (
                  <li key={f} className="flex items-start gap-2.5 text-sm text-white/80">
                    <Check className="w-4 h-4 text-[#C4922A] flex-shrink-0 mt-0.5" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/signup"
                className="block text-center text-sm font-bold bg-[#C4922A] text-white px-5 py-2.5 rounded-xl hover:bg-[#b07d24] transition-colors"
              >
                Upgrade now
              </Link>
            </div>
          </div>
        </section>

        {/* Credit top-up */}
        <section className="bg-[#F5F6FB] py-16">
          <div className="max-w-5xl mx-auto px-6">
            <div className="text-center mb-10">
              <div className="inline-flex items-center gap-2 bg-white border border-slate-200 text-[#1B2850] text-xs font-semibold px-3 py-1.5 rounded-full mb-4">
                <Zap className="w-3.5 h-3.5 text-[#C4922A]" />
                One-time purchases · No subscription
              </div>
              <h2 className="text-2xl font-bold text-slate-900 mb-2">Top up your credits</h2>
              <p className="text-slate-500 text-sm max-w-md mx-auto">
                Need a little more firepower? Purchase a credit pack anytime — they never expire.
              </p>
            </div>
            <div className="grid sm:grid-cols-3 gap-5 max-w-3xl mx-auto">
              {CREDIT_PACKS.map(pack => (
                <div
                  key={pack.credits}
                  className={cn(
                    'bg-white rounded-2xl p-6 border text-center relative',
                    pack.popular
                      ? 'border-[#C4922A] shadow-md shadow-[#C4922A]/10'
                      : 'border-slate-200 shadow-sm'
                  )}
                >
                  {pack.popular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                      <span className="bg-[#C4922A] text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full">
                        Best value
                      </span>
                    </div>
                  )}
                  <div className="w-10 h-10 bg-[#FDF3E3] rounded-xl flex items-center justify-center mx-auto mb-4">
                    <CreditCard className="w-5 h-5 text-[#C4922A]" />
                  </div>
                  <p className="text-3xl font-extrabold text-slate-900 mb-0.5">{pack.credits}</p>
                  <p className="text-xs text-slate-400 mb-3">credits · {pack.perCredit} each</p>
                  <p className="text-xl font-bold text-[#1B2850] mb-5">${pack.price}</p>
                  <Link
                    href="/signup"
                    className="block text-sm font-semibold text-[#1B2850] border border-[#1B2850] px-4 py-2 rounded-lg hover:bg-slate-50 transition-colors"
                  >
                    Buy credits
                  </Link>
                  <p className="text-[10px] text-slate-400 mt-3">One-time · No auto-renewal</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="max-w-2xl mx-auto px-6 py-16">
          <h2 className="text-2xl font-bold text-slate-900 mb-2 text-center">Frequently asked questions</h2>
          <p className="text-slate-500 text-sm text-center mb-10">Everything you need to know about credits and plans.</p>
          <div>
            {FAQS.map(faq => (
              <FaqItem key={faq.q} q={faq.q} a={faq.a} />
            ))}
          </div>
        </section>

        {/* Bottom CTA */}
        <section className="bg-gradient-to-br from-[#1B2850] to-[#2E4080] py-14 text-center">
          <h2 className="text-2xl font-bold text-white mb-3">Ready to grow your network?</h2>
          <p className="text-white/60 text-sm mb-8 max-w-sm mx-auto">
            Join professionals who believe the best opportunities come through trusted introductions.
          </p>
          <Link
            href="/signup"
            className="inline-flex items-center gap-2 bg-[#C4922A] text-white text-sm font-bold px-7 py-3 rounded-xl hover:bg-[#b07d24] transition-colors"
          >
            Get started for free
          </Link>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-100 py-6 text-center">
        <div className="flex items-center justify-center gap-2 text-xs text-slate-400">
          <Shield className="w-3.5 h-3.5" />
          Secure payments powered by Stripe — coming soon.
        </div>
        <p className="text-xs text-slate-300 mt-2">© {new Date().getFullYear()} Andrel. All rights reserved.</p>
      </footer>
    </div>
  )
}
