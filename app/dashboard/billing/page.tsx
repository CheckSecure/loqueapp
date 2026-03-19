import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getLoqueProducts } from '@/lib/stripe/products'
import CheckoutButton from '@/components/CheckoutButton'
import ManageBillingButton from '@/components/ManageBillingButton'
import { CreditCard, Zap, Crown, Star, CheckCircle } from 'lucide-react'
import Link from 'next/link'

export const metadata = { title: 'Billing | Loque' }

const TIER_ORDER = ['professional', 'executive']
const PLAN_ICONS: Record<string, any> = { professional: Star, executive: Crown }
const PLAN_COLORS: Record<string, string> = {
  professional: 'border-[#1B2850] bg-[#F5F6FB]',
  executive:    'border-[#C4922A] bg-[#FDF3E3]',
}
const PLAN_FEATURES: Record<string, string[]> = {
  professional: [
    '10 introduction credits / month',
    'Full messaging & meeting scheduling',
    'Access to all batch suggestions',
    'Profile visibility to all members',
  ],
  executive: [
    '30 introduction credits / month',
    'Priority matching algorithm',
    'Concierge onboarding call',
    'Dedicated member success manager',
    'All Professional features',
  ],
}

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(0)}`
}

export default async function BillingPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('subscription_tier, stripe_customer_id, stripe_subscription_id')
    .eq('id', user.id)
    .single()

  const { data: creditRow } = await supabase
    .from('meeting_credits')
    .select('balance')
    .eq('user_id', user.id)
    .single()

  const currentTier = profile?.subscription_tier ?? 'free'
  const creditBalance = creditRow?.balance ?? 0
  const hasStripeAccount = !!profile?.stripe_customer_id

  const products = await getLoqueProducts()

  // Separate subscription plans from credit packs
  const plans = TIER_ORDER.map(tier => {
    const prod = products.find(p => p.metadata?.tier === tier)
    const monthly = prod?.prices.find(p => p.interval === 'month')
    const annual  = prod?.prices.find(p => p.interval === 'year')
    return { tier, prod, monthly, annual }
  })

  const creditPacks = products.filter(p => p.metadata?.type === 'credit_pack')
    .sort((a, b) => {
      const credA = parseInt(a.metadata?.credits ?? '0')
      const credB = parseInt(b.metadata?.credits ?? '0')
      return credA - credB
    })

  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="max-w-3xl">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Billing</h1>
            <p className="text-slate-500 text-sm mt-0.5">Manage your subscription and credits</p>
          </div>
          {hasStripeAccount && <ManageBillingButton />}
        </div>

        {/* Current status */}
        <div className="bg-white border border-slate-100 rounded-xl p-5 shadow-sm mb-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-[#FDF3E3] rounded-xl flex items-center justify-center flex-shrink-0">
              <CreditCard className="w-5 h-5 text-[#C4922A]" />
            </div>
            <div>
              <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Current plan</p>
              <p className="text-lg font-bold text-slate-900 capitalize">{currentTier}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">Credits remaining</p>
            <p className="text-lg font-bold text-[#C4922A]">{creditBalance}</p>
          </div>
        </div>

        {/* Subscription plans */}
        {plans.some(p => p.prod) && (
          <section className="mb-10">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-4">Subscription plans</h2>
            <div className="grid sm:grid-cols-2 gap-4">
              {plans.map(({ tier, prod, monthly, annual }) => {
                if (!prod || !monthly) return null
                const Icon = PLAN_ICONS[tier] ?? Star
                const isCurrentTier = currentTier === tier
                return (
                  <div key={tier} className={`border-2 rounded-xl p-5 ${isCurrentTier ? PLAN_COLORS[tier] : 'border-slate-100 bg-white'}`}>
                    <div className="flex items-center gap-2 mb-3">
                      <Icon className={`w-4 h-4 ${tier === 'executive' ? 'text-[#C4922A]' : 'text-[#1B2850]'}`} />
                      <p className="text-sm font-bold text-slate-900 capitalize">{tier}</p>
                      {isCurrentTier && (
                        <span className="ml-auto text-[10px] font-semibold bg-[#1B2850] text-white px-2 py-0.5 rounded-full">Current</span>
                      )}
                    </div>
                    <p className="text-2xl font-extrabold text-slate-900 mb-0.5">
                      {fmt(monthly.amount)}<span className="text-sm font-medium text-slate-400">/mo</span>
                    </p>
                    {annual && (
                      <p className="text-xs text-slate-400 mb-4">
                        or {fmt(annual.amount)}/yr — save {Math.round(100 - (annual.amount / (monthly.amount * 12)) * 100)}%
                      </p>
                    )}
                    <ul className="space-y-1.5 mb-5">
                      {(PLAN_FEATURES[tier] ?? []).map(f => (
                        <li key={f} className="flex items-start gap-1.5 text-xs text-slate-600">
                          <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />
                          {f}
                        </li>
                      ))}
                    </ul>
                    {isCurrentTier ? (
                      <p className="text-xs text-center text-slate-400 font-medium py-2">You're on this plan</p>
                    ) : (
                      <div className="space-y-2">
                        <CheckoutButton
                          priceId={monthly.priceId}
                          label={`Upgrade to ${tier} — monthly`}
                          className={`w-full flex items-center justify-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors ${tier === 'executive' ? 'bg-[#C4922A] hover:bg-[#b07d24] text-white' : 'bg-[#1B2850] hover:bg-[#2E4080] text-white'}`}
                        />
                        {annual && (
                          <CheckoutButton
                            priceId={annual.priceId}
                            label={`Annual — ${fmt(annual.amount)}/yr`}
                            className="w-full flex items-center justify-center gap-2 text-xs font-semibold px-4 py-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                          />
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Credit packs */}
        {creditPacks.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-4">
              <Zap className="w-4 h-4 text-[#C4922A]" />
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Credit top-ups</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {creditPacks.map(pack => {
                const price = pack.prices[0]
                if (!price) return null
                const credits = parseInt(pack.metadata?.credits ?? '0')
                return (
                  <div key={pack.id} className="bg-white border border-slate-100 rounded-xl p-4 shadow-sm">
                    <p className="text-xl font-extrabold text-slate-900">{credits} <span className="text-sm font-medium text-slate-400">credits</span></p>
                    <p className="text-sm text-slate-500 mb-4">{fmt(price.amount)} one-time</p>
                    <CheckoutButton
                      priceId={price.priceId}
                      mode="payment"
                      label={`Buy ${credits} credits`}
                      className="w-full flex items-center justify-center text-xs font-semibold bg-[#FDF3E3] text-[#C4922A] border border-[#e8c88a] hover:bg-[#f5e7cc] px-3 py-2 rounded-lg transition-colors"
                    />
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Empty state while products not seeded */}
        {products.length === 0 && (
          <div className="bg-white border border-slate-100 rounded-xl p-12 text-center shadow-sm">
            <CreditCard className="w-10 h-10 text-slate-300 mx-auto mb-3" />
            <p className="text-sm font-semibold text-slate-700">Plans coming soon</p>
            <p className="text-xs text-slate-400 mt-1">
              Billing is being configured. Check back shortly.
            </p>
          </div>
        )}

        <p className="text-xs text-slate-400 text-center mt-8">
          Secured by Stripe · Cancel anytime · Questions?{' '}
          <a href="mailto:hello@loqueapp.com" className="underline hover:text-slate-600">hello@loqueapp.com</a>
        </p>
      </div>
    </div>
  )
}
