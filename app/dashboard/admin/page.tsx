import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Users, GitBranch, UserPlus, TrendingUp, MessageSquare, Calendar, Network, Search, Wrench, AlertCircle, Briefcase, Zap, ThumbsUp, Sparkles } from 'lucide-react'
import { getQueueHealthMetrics, type QueueHealthMetrics } from '@/lib/introductions/queue-metrics'

export const metadata = { title: 'Admin Dashboard | Andrel' }

const ADMIN_EMAIL = 'bizdev91@gmail.com'

export default async function AdminDashboard() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  // Get key metrics
  const { count: totalMembers } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('account_status', 'active')

  const { count: pendingIntros } = await supabase
    .from('intro_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'admin_pending')

  // Issue reports — uses admin client so RLS doesn't restrict to admin's own reports
  const adminClient = createAdminClient()
  const { count: newIssueCount } = await adminClient
    .from('issue_reports')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'new')

  // Pending Concierge requests awaiting triage
  const { count: pendingConciergeCount } = await adminClient
    .from('concierge_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')

  // Recommendation-queue health (operational; never shown to members). Resilient to
  // the recommendation_batches table not existing yet (pre-migration → all zeros).
  let queueHealth: QueueHealthMetrics | null = null
  try {
    queueHealth = await getQueueHealthMetrics(adminClient)
  } catch (err) {
    console.warn('[admin] queue health metrics unavailable (apply migration 020):', (err as any)?.message)
  }

  // Shared time windows
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // Opportunities activity (last 7 days) — read-only metrics, no navigation
  const { count: opportunitiesCreated7d } = await adminClient
    .from('opportunities')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', sevenDaysAgo)
  const { count: opportunityResponses7d } = await adminClient
    .from('opportunity_responses')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', sevenDaysAgo)

  // Platform health counts — all adminClient to avoid RLS silent-zero failures
  const { count: totalMatches } = await adminClient
    .from('matches')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')
    .is('removed_at', null)

  const { count: totalRegistered } = await adminClient
    .from('profiles')
    .select('id', { count: 'exact', head: true })

  const { count: activeUsers7d } = await adminClient
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .gte('last_active_at', sevenDaysAgo)

  // Waitlist Pipeline — all statuses with breakdown
  const { data: allWaitlistEntries } = await adminClient
    .from('waitlist')
    .select('status')
  const waitlistTotal = allWaitlistEntries?.length || 0
  const waitlistByStatus = {
    pending:  allWaitlistEntries?.filter(w => w.status === 'pending').length  || 0,
    approved: allWaitlistEntries?.filter(w => w.status === 'approved').length || 0,
    invited:  allWaitlistEntries?.filter(w => w.status === 'invited').length  || 0,
    declined: allWaitlistEntries?.filter(w => w.status === 'declined').length || 0,
  }

  // Card 5: Intros Suggested (7d)
  const { count: introsSuggested7d } = await adminClient
    .from('batch_suggestions')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', sevenDaysAgo)

  // Card 6: Interest Expressed (7d) — user-initiated only
  const { count: interestExpressed7d } = await adminClient
    .from('intro_requests')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', sevenDaysAgo)
    .eq('is_admin_initiated', false)

  // Card 7: Messages Sent (7d, non-system)
  const { count: messagesSent7d } = await adminClient
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('is_system', false)
    .gte('created_at', sevenDaysAgo)

  // Card 8: Meetings Scheduled (7d, all statuses)
  const { count: meetingsScheduled7d } = await adminClient
    .from('meetings')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', sevenDaysAgo)

  // Get current batch info. Approval state is tracked via status:
  // generated -> active (approved) -> completed. No approved_at column exists.
  const { data: currentBatch } = await supabase
    .from('introduction_batches')
    .select('id, status, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { count: batchSuggestions } = currentBatch ? await adminClient
    .from('batch_suggestions')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', currentBatch.id)
    : { count: 0 }

  // ── Derived-only values (no new queries — all sources fetched above) ──
  // Weekly-active percentage: both numerator (activeUsers7d) and denominator
  // (totalRegistered) are already fetched, so the % is safe to derive.
  const weeklyActivePct = (totalRegistered && totalRegistered > 0)
    ? Math.round(((activeUsers7d || 0) / totalRegistered) * 100)
    : null

  const batchNeedsReview = Boolean(currentBatch && currentBatch.status !== 'active')

  // Needs Attention — reuses existing counts only; zero-value rows are excluded.
  const attentionItems = [
    { label: `${waitlistByStatus.pending} awaiting approval`, href: '/dashboard/admin/waitlist', show: waitlistByStatus.pending > 0, tone: 'red' as const },
    { label: `${pendingConciergeCount} concierge request${(pendingConciergeCount || 0) === 1 ? '' : 's'}`, href: '/dashboard/admin/concierge', show: (pendingConciergeCount || 0) > 0, tone: 'yellow' as const },
    { label: `${newIssueCount} issue report${(newIssueCount || 0) === 1 ? '' : 's'}`, href: '/dashboard/admin/issues', show: (newIssueCount || 0) > 0, tone: 'red' as const },
    { label: `${pendingIntros} admin intro${(pendingIntros || 0) === 1 ? '' : 's'} awaiting response`, href: '/dashboard/admin/members', show: (pendingIntros || 0) > 0, tone: 'yellow' as const },
    { label: 'Current batch needs review', href: '/dashboard/admin/batches', show: batchNeedsReview, tone: 'yellow' as const },
  ].filter(i => i.show)

  // Status accent classes keyed by real state.
  const toneTop: Record<string, string> = {
    red: 'border-t-red-400', yellow: 'border-t-amber-400', green: 'border-t-emerald-400', blue: 'border-t-sky-300', neutral: 'border-t-slate-200',
  }
  const toneDot: Record<string, string> = {
    red: 'bg-red-500', yellow: 'bg-amber-500', green: 'bg-emerald-500', blue: 'bg-sky-400', neutral: 'bg-slate-300',
  }
  const oppsHasActivity = (opportunitiesCreated7d || 0) > 0 || (opportunityResponses7d || 0) > 0

  const navCardBase = 'bg-white rounded-xl border border-slate-200 border-t-2 p-5 hover:border-[#1B2850]/30 hover:shadow-md transition-all group'
  const iconChip = 'w-11 h-11 rounded-lg bg-[#F5F6FB] flex items-center justify-center group-hover:bg-[#1B2850] transition-colors'
  const iconCls = 'w-5 h-5 text-[#1B2850] group-hover:text-white transition-colors'

  return (
    <div className="min-h-screen bg-slate-50 p-5 sm:p-6">
      <div className="max-w-7xl mx-auto space-y-5">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Admin Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">Launch operations console</p>
        </div>

        {/* Recommendation queue health — operational, member-invisible */}
        {queueHealth && (
          <div>
            <h2 className="text-sm font-semibold text-slate-700 mb-2">Recommendation queue health</h2>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: 'No active batch', value: queueHealth.noActiveBatch },
                { label: 'Active only', value: queueHealth.activeBatchOnly },
                { label: 'Queued batch waiting', value: queueHealth.withQueuedBatch },
                { label: 'Awaiting weekly gen', value: queueHealth.waitingForWeeklyGeneration },
                { label: 'Awaiting admin batch', value: queueHealth.waitingOnAdminBatch },
              ].map((m) => (
                <div key={m.label} className="bg-white rounded-xl border border-slate-200 p-4">
                  <p className="text-2xl font-bold text-slate-900">{m.value}</p>
                  <p className="text-[11px] text-slate-500 mt-1 leading-tight">{m.label}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Top metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="flex items-center justify-between mb-1.5">
              <Users className="w-5 h-5 text-[#1B2850]" />
            </div>
            <p className="text-3xl font-bold text-slate-900 leading-none">{totalRegistered || 0}</p>
            <p className="text-xs text-slate-500 mt-1">Members</p>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="flex items-center justify-between mb-1.5">
              <TrendingUp className="w-5 h-5 text-amber-600" />
              <span className="text-[11px] text-slate-400">7d</span>
            </div>
            <p className="text-3xl font-bold text-slate-900 leading-none">{activeUsers7d || 0}</p>
            <p className="text-xs text-slate-500 mt-1">
              Weekly Active{weeklyActivePct !== null && <span className="text-slate-400"> · {weeklyActivePct}% of members</span>}
            </p>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="flex items-center justify-between mb-1.5">
              <Network className="w-5 h-5 text-green-600" />
            </div>
            <p className="text-3xl font-bold text-slate-900 leading-none">{totalMatches || 0}</p>
            <p className="text-xs text-slate-500 mt-1">Active Matches</p>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="flex items-center justify-between mb-1.5">
              <UserPlus className="w-5 h-5 text-sky-500" />
            </div>
            <p className="text-3xl font-bold text-slate-900 leading-none">{waitlistByStatus.pending}</p>
            <p className="text-xs text-slate-500 mt-1">Waitlist · awaiting review</p>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
              <span>{waitlistByStatus.approved} approved</span>
              <span>{waitlistByStatus.invited} invited</span>
              <span>{waitlistByStatus.declined} declined</span>
            </div>
          </div>
        </div>

        {/* Needs Attention */}
        <div>
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">Needs Attention</h2>
          <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
            {attentionItems.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-500">No items currently require attention.</p>
            ) : (
              attentionItems.map((item) => (
                <Link key={item.label} href={item.href} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${toneDot[item.tone]}`} aria-hidden="true" />
                  <span className="flex-1 text-sm font-medium text-slate-800">{item.label}</span>
                  <span className="text-slate-300 group-hover:text-slate-400">→</span>
                </Link>
              ))
            )}
          </div>
        </div>

        {/* Engagement — Last 7 Days */}
        <div>
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-2">Last 7 Days</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center justify-between mb-1.5"><Zap className="w-5 h-5 text-amber-500" /></div>
              <p className="text-3xl font-bold text-slate-900 leading-none">{introsSuggested7d || 0}</p>
              <p className="text-xs text-slate-500 mt-1">Intros Suggested</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center justify-between mb-1.5"><ThumbsUp className="w-5 h-5 text-green-500" /></div>
              <p className="text-3xl font-bold text-slate-900 leading-none">{interestExpressed7d || 0}</p>
              <p className="text-xs text-slate-500 mt-1">Interest Expressed</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center justify-between mb-1.5"><MessageSquare className="w-5 h-5 text-blue-500" /></div>
              <p className="text-3xl font-bold text-slate-900 leading-none">{messagesSent7d || 0}</p>
              <p className="text-xs text-slate-500 mt-1">Messages Sent</p>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center justify-between mb-1.5"><Calendar className="w-5 h-5 text-indigo-500" /></div>
              <p className="text-3xl font-bold text-slate-900 leading-none">{meetingsScheduled7d || 0}</p>
              <p className="text-xs text-slate-500 mt-1">Meetings Scheduled</p>
            </div>
          </div>
        </div>

        {/* Main Navigation Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">

          {/* Waitlist */}
          <Link href="/dashboard/admin/waitlist" className={`${navCardBase} ${toneTop[waitlistByStatus.pending > 0 ? 'red' : 'green']}`}>
            <div className="flex items-start justify-between mb-3">
              <div className={iconChip}><UserPlus className={iconCls} /></div>
              {(waitlistByStatus.pending || 0) > 0 && (
                <span className="w-6 h-6 bg-red-500 text-white text-[11px] font-bold rounded-full flex items-center justify-center">
                  {(waitlistByStatus.pending || 0) > 9 ? '9+' : waitlistByStatus.pending}
                </span>
              )}
            </div>
            <h3 className="text-base font-bold text-slate-900 mb-1">Waitlist</h3>
            <p className="text-xs text-slate-500 mb-2.5">Approve new members, send invites, manage access</p>
            <div className="text-xs text-slate-600"><span>{waitlistByStatus.pending || 0} pending approval</span></div>
          </Link>

          {/* Batch Management */}
          <Link href="/dashboard/admin/batches" className={`${navCardBase} ${toneTop[batchNeedsReview ? 'yellow' : 'green']}`}>
            <div className="flex items-start justify-between mb-3">
              <div className={iconChip}><GitBranch className={iconCls} /></div>
              {batchNeedsReview && (
                <span className="px-2 py-1 bg-amber-100 text-amber-700 text-xs font-medium rounded">Needs Review</span>
              )}
            </div>
            <h3 className="text-base font-bold text-slate-900 mb-1">Batch Management</h3>
            <p className="text-xs text-slate-500 mb-2.5">Generate weekly batches, review suggestions, approve recommendations</p>
            <div className="text-xs text-slate-600">{currentBatch && <span>{batchSuggestions || 0} suggestions in current batch</span>}</div>
          </Link>

          {/* Members */}
          <Link href="/dashboard/admin/members" className={`${navCardBase} ${toneTop[(pendingIntros || 0) > 0 ? 'yellow' : 'neutral']}`}>
            <div className="flex items-start justify-between mb-3">
              <div className={iconChip}><Users className={iconCls} /></div>
            </div>
            <h3 className="text-base font-bold text-slate-900 mb-1">Members</h3>
            <p className="text-xs text-slate-500 mb-2.5">Manage users, boost priority, force matches, edit tiers and credits</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
              <span>{totalMembers || 0} active</span>
              {(pendingIntros || 0) > 0 && <span className="text-amber-600 font-medium">{pendingIntros} admin intro{pendingIntros === 1 ? '' : 's'} awaiting response</span>}
            </div>
          </Link>

          {/* Concierge Queue */}
          <Link href="/dashboard/admin/concierge" className={`${navCardBase} ${toneTop[(pendingConciergeCount || 0) > 0 ? 'yellow' : 'green']}`}>
            <div className="flex items-start justify-between mb-3">
              <div className={iconChip}><Sparkles className={iconCls} /></div>
              {(pendingConciergeCount || 0) > 0 && (
                <span className="w-6 h-6 bg-red-500 text-white text-[11px] font-bold rounded-full flex items-center justify-center">
                  {(pendingConciergeCount || 0) > 9 ? '9+' : pendingConciergeCount}
                </span>
              )}
            </div>
            <h3 className="text-base font-bold text-slate-900 mb-1">Concierge Queue</h3>
            <p className="text-xs text-slate-500 mb-2.5">Member-requested introductions — triage pending requests</p>
            <div className="text-xs text-slate-600"><span>{(pendingConciergeCount || 0) > 0 ? `${pendingConciergeCount} pending` : 'No pending requests'}</span></div>
          </Link>

          {/* Opportunities — read-only metrics card */}
          <div className={`bg-white rounded-xl border border-slate-200 border-t-2 ${toneTop.blue} p-5`}>
            <div className="flex items-start justify-between mb-3">
              <div className="w-11 h-11 rounded-lg bg-[#F5F6FB] flex items-center justify-center"><Briefcase className="w-5 h-5 text-[#1B2850]" /></div>
            </div>
            <h3 className="text-base font-bold text-slate-900 mb-2.5">Opportunities</h3>
            {oppsHasActivity ? (
              <div className="flex gap-6">
                <div>
                  <p className="text-2xl font-bold text-slate-900 leading-none">{opportunitiesCreated7d || 0}</p>
                  <p className="text-xs text-slate-500 mt-1">Created (7d)</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-slate-900 leading-none">{opportunityResponses7d || 0}</p>
                  <p className="text-xs text-slate-500 mt-1">Responses (7d)</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-400">No activity this week</p>
            )}
          </div>

          {/* Launch Metrics */}
          <Link href="/dashboard/admin/metrics" className={`${navCardBase} ${toneTop.blue}`}>
            <div className="flex items-start justify-between mb-3">
              <div className={iconChip}><TrendingUp className={iconCls} /></div>
            </div>
            <h3 className="text-base font-bold text-slate-900 mb-1">Launch Metrics</h3>
            <p className="text-xs text-slate-500">Founding member activation, intros, matches, meetings, and opportunities</p>
          </Link>

          {/* Match Inspector */}
          <Link href="/dashboard/admin/match-inspector" className={`${navCardBase} ${toneTop.blue}`}>
            <div className="flex items-start justify-between mb-3">
              <div className={iconChip}><Search className={iconCls} /></div>
            </div>
            <h3 className="text-base font-bold text-slate-900 mb-1">Match Inspector</h3>
            <p className="text-xs text-slate-500 mb-2.5">Inspect any pair — relationship state, eligibility, insights, and override tools</p>
            <div className="text-xs text-slate-600"><span>Pair lookup &amp; manual actions</span></div>
          </Link>

          {/* Platform Operations */}
          <Link href="/dashboard/admin/operations" className={`${navCardBase} ${toneTop.blue}`}>
            <div className="flex items-start justify-between mb-3">
              <div className={iconChip}><Wrench className={iconCls} /></div>
            </div>
            <h3 className="text-base font-bold text-slate-900 mb-1">Platform Operations</h3>
            <p className="text-xs text-slate-500 mb-2.5">Advanced tools for debugging, manual overrides, and system support.</p>
            <div className="text-xs text-slate-600"><span>Support &amp; debug tools</span></div>
          </Link>

          {/* Issue Reports */}
          <Link href="/dashboard/admin/issues" className={`${navCardBase} ${toneTop[(newIssueCount || 0) > 0 ? 'red' : 'green']}`}>
            <div className="flex items-start justify-between mb-3">
              <div className={iconChip}><AlertCircle className={iconCls} /></div>
              {(newIssueCount || 0) > 0 && (
                <span className="w-6 h-6 bg-red-500 text-white text-[11px] font-bold rounded-full flex items-center justify-center">
                  {(newIssueCount || 0) > 9 ? '9+' : newIssueCount}
                </span>
              )}
            </div>
            <h3 className="text-base font-bold text-slate-900 mb-1">Issue Reports</h3>
            <p className="text-xs text-slate-500 mb-2.5">User-submitted bug reports and support questions</p>
            <div className="text-xs text-slate-600"><span>{(newIssueCount || 0) > 0 ? `${newIssueCount} unreviewed` : 'No new reports'}</span></div>
          </Link>

        </div>
      </div>
    </div>
  )
}
