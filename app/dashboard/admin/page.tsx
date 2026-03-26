import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import { adminGetPendingRequests } from '@/lib/introRequests'
import AdminIntroRequests from '@/components/AdminIntroRequests'
import AdminWaitlist from '@/components/AdminWaitlist'
import AdminStats from '@/components/AdminStats'
import AdminUsers from '@/components/AdminUsers'
import AdminBatchButton from '@/components/AdminBatchButton'
import AdminMutualInterest from '@/components/AdminMutualInterest'
import ComputeScoresButton from '@/components/ComputeScoresButton'
import AdminMemberList from '@/components/AdminMemberList'
import AdminPendingBatches from '@/components/AdminPendingBatches'
import { ShieldCheck, Users, BarChart2, Sparkles } from 'lucide-react'

export const metadata = { title: 'Admin | Andrel' }

export default async function AdminPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  if (user.email !== 'bizdev91@gmail.com') redirect('/dashboard/introductions')

  // Fetch all data in parallel
  const [
    { data: mutualRequests },
    { data: pending },
    { data: waitlistEntries },
    { count: totalUsers },
    { count: activeThisWeek },
    { count: connectionsMade },
    { count: meetingsBooked },
    { data: profileRows },
    { data: creditRows },
  ] = await Promise.all([
    createAdminClient().from('intro_requests').select('id, requester_id, target_user_id, requester:profiles!requester_id(full_name, role_type), target:profiles!target_user_id(full_name, role_type)').eq('status', 'pending'),
    adminGetPendingRequests(),
    supabase.from('waitlist').select('id, full_name, email, company, role_type, referral_source, status, created_at').order('created_at', { ascending: false }),
    supabase.from('profiles').select('*', { count: 'exact', head: true }),
    supabase.from('profiles').select('*', { count: 'exact', head: true }).gte('updated_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
    supabase.from('matches').select('*', { count: 'exact', head: true }),
    supabase.from('meetings').select('*', { count: 'exact', head: true }),
    supabase.from('profiles').select('id, full_name, email, role_type, subscription_tier, admin_priority, seniority').order('full_name'),
    supabase.from('meeting_credits').select('user_id, balance'),
  ])

  // Compute mutual interest pairs
  const allRequests = mutualRequests ?? []
  const mutualPairs: any[] = []
  const seenPairs: string[] = []
  for (const r of allRequests) {
    const reverse = allRequests.find((x: any) =>
      x.requester_id === r.target_user_id && x.target_user_id === r.requester_id
    )
    if (reverse) {
      const key = [r.requester_id, r.target_user_id].sort().join('-')
      if (!seenPairs.includes(key)) {
        seenPairs.push(key)
        mutualPairs.push({
          user_a_id: r.requester_id,
          user_a_name: (r.requester as any)?.full_name ?? 'Unknown',
          user_a_role: (r.requester as any)?.role_type ?? '',
          user_b_id: r.target_user_id,
          user_b_name: (r.target as any)?.full_name ?? 'Unknown',
          user_b_role: (r.target as any)?.role_type ?? '',
          request_a_id: r.id,
          request_b_id: reverse.id,
        })
      }
    }
  }

  const creditMap: Record<string, number> = {}
  for (const row of creditRows ?? []) creditMap[row.user_id] = row.balance

  const users = (profileRows ?? []).map((p: any) => ({
    id: p.id,
    full_name: p.full_name,
    email: p.email,
    role_type: p.role_type,
    subscription_tier: p.subscription_tier ?? 'free',
    admin_priority: p.admin_priority ?? 'standard',
    seniority: p.seniority ?? '',
    balance: creditMap[p.id] ?? 0,
  }))

  const stats = {
    totalUsers: totalUsers ?? 0,
    activeThisWeek: activeThisWeek ?? 0,
    connectionsMade: connectionsMade ?? 0,
    meetingsBooked: meetingsBooked ?? 0,
  }

  return (
    <div className="p-6 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="max-w-5xl">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-9 h-9 bg-[#FDF3E3] rounded-lg flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-[#C4922A]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Admin</h1>
            <p className="text-slate-500 text-sm mt-0.5">Platform overview and member management</p>
          </div>
        </div>

        {/* Stats */}
        <AdminStats stats={stats} />

        {/* Members */}
        <section className="mb-12">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-[#C4922A]" />
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Members · {users.length}
              </h2>
            </div>
          </div>
          <AdminUsers users={users} />
        </section>

        {/* Intro batch generation */}
        <section className="mb-12">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#C4922A]" />
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Weekly recommendations
              </h2>
            </div>
          </div>
          <div className="bg-white border border-slate-100 rounded-xl p-5 shadow-sm flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-slate-900">Generate new batch</p>
              <p className="text-xs text-slate-400 mt-0.5">
                Runs role-based matching and pushes a fresh set of recommendations to all members. Closes the current active batch first.
              </p>
            </div>
            <AdminBatchButton />
          </div>
        <AdminPendingBatches />
        </section>

        {/* Score computation */}
        <div className="mb-8 flex items-center justify-between bg-white border border-slate-100 rounded-xl px-5 py-4 shadow-sm">
          <div>
            <p className="text-sm font-semibold text-slate-900">Andrel Scores</p>
            <p className="text-xs text-slate-400 mt-0.5">Internal scores updated daily. Influences match quality and exposure.</p>
          </div>
          <ComputeScoresButton />
        </div>

        {/* Mutual Interest */}
        <AdminMutualInterest pairs={mutualPairs} />

        {/* Waitlist */}
        <section className="mb-12">
          <div className="flex items-center gap-2 mb-4">
            <BarChart2 className="w-4 h-4 text-[#C4922A]" />
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Waitlist · {waitlistEntries?.length ?? 0} total
            </h2>
          </div>
          <AdminWaitlist initial={waitlistEntries ?? []} />
        </section>

        {/* Intro requests */}
        <section>
          <div className="mb-4 flex items-center gap-2">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Intro requests · {pending?.length ?? 0} total
            </h2>
            {(pending ?? []).filter((r: any) => r.status === 'pending').length > 0 && (
              <span className="text-[10px] font-bold bg-amber-500 text-white px-2 py-0.5 rounded-full">
                {(pending ?? []).filter((r: any) => r.status === 'pending').length} pending
              </span>
            )}
          </div>
          <AdminIntroRequests initial={pending ?? []} />
        </section>
      </div>
    </div>
  )
}
