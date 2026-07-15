import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, UserPlus, Zap, UserCheck, ThumbsUp, Network, MessageSquare, Calendar, Briefcase } from 'lucide-react'

export const metadata = { title: 'Launch Metrics | Admin' }
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

// Counts auth users that have ever signed in (last_sign_in_at not null) — the
// established activation marker (see app/api/cron/activation-reminders). Paginates
// listUsers; at launch scale (tens of users) this is a single page.
async function countActivatedUsers(admin: ReturnType<typeof createAdminClient>): Promise<number> {
  // Exclude internal QA accounts so they don't inflate the activated-member count.
  const { data: testRows } = await admin.from('profiles').select('id').eq('is_test_account', true)
  const testIds = new Set((testRows ?? []).map((r) => r.id))
  let activated = 0
  let page = 1
  const perPage = 1000
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage })
    if (error) break
    for (const u of data.users) if (u.last_sign_in_at && !testIds.has(u.id)) activated++
    if (data.users.length < perPage) break
    page++
  }
  return activated
}

function MetricCard({ icon: Icon, value, label, sub }: {
  icon: React.ElementType
  value: string | number
  label: string
  sub?: string | null
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <Icon className="w-5 h-5 text-[#1B2850] mb-2" />
      <p className="text-3xl font-bold text-slate-900">{value}</p>
      <p className="text-xs text-slate-500 mt-1">{label}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  )
}

export default async function AdminMetricsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  const admin = createAdminClient()

  const [
    invitedRes,
    totalProfilesRes,
    completeProfilesRes,
    introPositiveRes,
    introNegativeRes,
    mutualMatchesRes,
    conversationsRes,
    meetingsRes,
    opportunitiesRes,
    activatedCount,
  ] = await Promise.all([
    admin.from('waitlist').select('id', { count: 'exact', head: true }).eq('status', 'invited').not('invited_at', 'is', null),
    admin.from('profiles').select('id', { count: 'exact', head: true }).not('is_test_account', 'is', true),
    admin.from('profiles').select('id', { count: 'exact', head: true }).eq('profile_complete', true).not('is_test_account', 'is', true),
    // Intro acceptance: positive vs negative terminal decisions on intro_requests.
    admin.from('intro_requests').select('id', { count: 'exact', head: true }).in('status', ['accepted', 'approved']),
    admin.from('intro_requests').select('id', { count: 'exact', head: true }).in('status', ['declined', 'expired']),
    admin.from('matches').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    admin.from('conversations').select('id', { count: 'exact', head: true }),
    admin.from('meetings').select('id', { count: 'exact', head: true }).in('status', ['scheduled', 'confirmed']),
    admin.from('opportunities').select('id', { count: 'exact', head: true }),
    countActivatedUsers(admin),
  ])

  const invited = invitedRes.count ?? 0
  const totalProfiles = totalProfilesRes.count ?? 0
  const completeProfiles = completeProfilesRes.count ?? 0
  const introPositive = introPositiveRes.count ?? 0
  const introNegative = introNegativeRes.count ?? 0
  const mutualMatches = mutualMatchesRes.count ?? 0
  const conversations = conversationsRes.count ?? 0
  const meetingsBooked = meetingsRes.count ?? 0
  const opportunities = opportunitiesRes.count ?? 0

  const activationPct = invited > 0 ? Math.round((activatedCount / invited) * 100) : null
  const profileCompletionPct = totalProfiles > 0 ? Math.round((completeProfiles / totalProfiles) * 100) : 0
  const introDecided = introPositive + introNegative
  const introAcceptancePct = introDecided > 0 ? Math.round((introPositive / introDecided) * 100) : null

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <Link href="/dashboard/admin" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#1B2850] transition-colors mb-3">
            <ArrowLeft className="w-4 h-4" />
            Admin
          </Link>
          <h1 className="text-2xl font-bold text-slate-900">Launch Metrics</h1>
          <p className="text-sm text-slate-500 mt-1">Founding member activity, derived live from the database.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard icon={UserPlus} value={invited} label="Members invited" />
          <MetricCard
            icon={Zap}
            value={activatedCount}
            label="Members activated"
            sub={activationPct !== null ? `${activationPct}% of invited` : null}
          />
          <MetricCard
            icon={UserCheck}
            value={`${profileCompletionPct}%`}
            label="Profile completion"
            sub={`${completeProfiles} of ${totalProfiles}`}
          />
          <MetricCard
            icon={ThumbsUp}
            value={introAcceptancePct !== null ? `${introAcceptancePct}%` : '—'}
            label="Intro acceptance rate"
            sub={introDecided > 0 ? `${introPositive} of ${introDecided} decided` : 'no decisions yet'}
          />
          <MetricCard icon={Network} value={mutualMatches} label="Mutual matches" />
          <MetricCard icon={MessageSquare} value={conversations} label="Conversations started" />
          <MetricCard icon={Calendar} value={meetingsBooked} label="Meetings booked" />
          <MetricCard icon={Briefcase} value={opportunities} label="Opportunities created" />
        </div>
      </div>
    </div>
  )
}
