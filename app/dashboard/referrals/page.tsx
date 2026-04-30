import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import ReferralForm from './ReferralForm'

export const metadata = { title: 'Referrals | Andrel' }

type ReferralRow = {
  id: string
  referral_note: string
  status: 'pending' | 'invited' | 'activated' | 'rejected'
  created_at: string
  waitlist: {
    full_name: string
    email: string
    title: string | null
    company: string | null
  } | null
}

const STATUS_LABEL: Record<string, string> = {
  pending:   'Pending review',
  invited:   'Invited',
  activated: 'Member',
  rejected:  'Not approved',
}

const STATUS_CLASS: Record<string, string> = {
  pending:   'bg-slate-100 text-slate-500',
  invited:   'bg-[#FDF3E3] text-[#C4922A]',
  activated: 'bg-green-50 text-green-700',
  rejected:  'bg-red-50 text-red-500',
}

const SLOTS_TOTAL = 3

export default async function ReferralsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  const { data: referrals } = await supabase
    .from('referrals')
    .select('id, referral_note, status, created_at, waitlist:waitlist_id(full_name, email, title, company)')
    .eq('referrer_user_id', user.id)
    .order('created_at', { ascending: false })

  const rows = (referrals ?? []) as ReferralRow[]
  const outstandingCount = rows.filter(r => r.status === 'pending' || r.status === 'invited').length
  const canRefer = outstandingCount < SLOTS_TOTAL

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-12 space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Referrals</h1>
        <p className="text-slate-500 text-sm mt-2">
          Andrel grows through trusted referrals. Invite someone you'd genuinely want to meet or introduce to others.
        </p>
        <p className="text-slate-400 text-xs mt-1">When someone you refer becomes a member, you'll receive 1 credit, up to 5 per month.</p>
      </div>

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Refer someone</h2>
          <span className="text-xs text-slate-400">{outstandingCount} / {SLOTS_TOTAL} slots used</span>
        </div>
        <div className="px-6 py-5">
          {canRefer ? (
            <ReferralForm userEmail={user.email ?? ''} />
          ) : (
            <p className="text-sm text-slate-500">
              You've used all 3 referral slots. Your slots will free up as referrals are reviewed.
            </p>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100">
            <h2 className="text-sm font-semibold text-slate-900">Your referrals</h2>
          </div>
          <div className="divide-y divide-slate-50">
            {rows.map(r => (
              <div key={r.id} className="px-6 py-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">{r.waitlist?.full_name ?? '—'}</p>
                  <p className="text-xs text-slate-400 truncate">{r.waitlist?.email}</p>
                  {(r.waitlist?.title || r.waitlist?.company) && (
                    <p className="text-xs text-slate-400 mt-0.5 truncate">
                      {[r.waitlist.title, r.waitlist.company].filter(Boolean).join(' · ')}
                    </p>
                  )}
                </div>
                <span className={`flex-shrink-0 text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_CLASS[r.status] ?? 'bg-slate-100 text-slate-500'}`}>
                  {STATUS_LABEL[r.status] ?? r.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
