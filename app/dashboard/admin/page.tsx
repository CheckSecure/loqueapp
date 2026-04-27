import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Users, GitBranch, UserPlus, Inbox, TrendingUp, MessageSquare, Calendar, Network, Search, Wrench, AlertCircle, Briefcase } from 'lucide-react'

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

  const { count: totalMatches } = await supabase
    .from('matches')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'active')

  const { count: totalMeetings } = await supabase
    .from('meetings')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'confirmed')

  const { count: pendingIntros } = await supabase
    .from('intro_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'admin_pending')

  const { count: waitlistCount } = await supabase
    .from('waitlist')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')

  // Issue reports — uses admin client so RLS doesn't restrict to admin's own reports
  const adminClient = createAdminClient()
  const { count: newIssueCount } = await adminClient
    .from('issue_reports')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'new')

  // Opportunities activity (last 7 days) — read-only metrics, no navigation
  const opportunityWindowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { count: opportunitiesCreated7d } = await adminClient
    .from('opportunities')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', opportunityWindowStart)
  const { count: opportunityResponses7d } = await adminClient
    .from('opportunity_responses')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', opportunityWindowStart)

  // Count distinct users who sent a real message in the last 7 days.
  // This replaces profiles.updated_at which measured profile mutations, not activity.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data: recentSenders } = await supabase
    .from('messages')
    .select('sender_id')
    .gte('created_at', sevenDaysAgo)
    .eq('is_system', false)
    .not('sender_id', 'is', null)
  const activeWeekCount = new Set((recentSenders || []).map(m => m.sender_id)).size

  // Get current batch info. Approval state is tracked via status:
  // generated -> active (approved) -> completed. No approved_at column exists.
  const { data: currentBatch } = await supabase
    .from('introduction_batches')
    .select('id, status, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { count: batchSuggestions } = currentBatch ? await supabase
    .from('batch_suggestions')
    .select('id', { count: 'exact', head: true })
    .eq('batch_id', currentBatch.id)
    : { count: 0 }

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Admin Dashboard</h1>
          <p className="text-sm text-slate-500 mt-1">Platform control center</p>
        </div>

        {/* Key Metrics */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-center justify-between mb-2">
              <Users className="w-5 h-5 text-[#1B2850]" />
              <span className="text-xs text-slate-500">Active</span>
            </div>
            <p className="text-3xl font-bold text-slate-900">{totalMembers || 0}</p>
            <p className="text-xs text-slate-500 mt-1">Active Members</p>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-center justify-between mb-2">
              <Network className="w-5 h-5 text-green-600" />
              <span className="text-xs text-slate-500">All time</span>
            </div>
            <p className="text-3xl font-bold text-slate-900">{totalMatches || 0}</p>
            <p className="text-xs text-slate-500 mt-1">Active Connections</p>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-center justify-between mb-2">
              <Calendar className="w-5 h-5 text-blue-600" />
              <span className="text-xs text-slate-500">All time</span>
            </div>
            <p className="text-3xl font-bold text-slate-900">{totalMeetings || 0}</p>
            <p className="text-xs text-slate-500 mt-1">Meetings Confirmed</p>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-center justify-between mb-2">
              <TrendingUp className="w-5 h-5 text-amber-600" />
              <span className="text-xs text-slate-500">Last 7 days</span>
            </div>
            <p className="text-3xl font-bold text-slate-900">{activeWeekCount || 0}</p>
            <p className="text-xs text-slate-500 mt-1">Active This Week</p>
          </div>
        </div>

        {/* Main Navigation Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          
          {/* Members */}
          <Link
            href="/dashboard/admin/members"
            className="bg-white rounded-xl border border-slate-200 p-6 hover:border-[#1B2850]/30 hover:shadow-md transition-all group"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="w-12 h-12 rounded-lg bg-[#F5F6FB] flex items-center justify-center group-hover:bg-[#1B2850] transition-colors">
                <Users className="w-6 h-6 text-[#1B2850] group-hover:text-white transition-colors" />
              </div>
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">Members</h3>
            <p className="text-sm text-slate-500 mb-4">
              Manage users, boost priority, force matches, edit tiers and credits
            </p>
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span>{totalMembers || 0} active</span>
              {(pendingIntros || 0) > 0 && <span className="text-amber-600 font-medium">{pendingIntros} admin intro{pendingIntros === 1 ? '' : 's'} awaiting response</span>}
            </div>
          </Link>

          {/* Batch Management */}
          <Link
            href="/dashboard/admin/batches"
            className="bg-white rounded-xl border border-slate-200 p-6 hover:border-[#1B2850]/30 hover:shadow-md transition-all group"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="w-12 h-12 rounded-lg bg-[#F5F6FB] flex items-center justify-center group-hover:bg-[#1B2850] transition-colors">
                <GitBranch className="w-6 h-6 text-[#1B2850] group-hover:text-white transition-colors" />
              </div>
              {currentBatch && currentBatch.status !== 'active' && (
                <span className="px-2 py-1 bg-amber-100 text-amber-700 text-xs font-medium rounded">
                  Needs Review
                </span>
              )}
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">Batch Management</h3>
            <p className="text-sm text-slate-500 mb-4">
              Generate weekly batches, review suggestions, approve recommendations
            </p>
            <div className="flex items-center gap-4 text-xs text-slate-600">
              {currentBatch && <span>{batchSuggestions || 0} suggestions in current batch</span>}
            </div>
          </Link>

          {/* Waitlist */}
          <Link
            href="/dashboard/admin/waitlist"
            className="bg-white rounded-xl border border-slate-200 p-6 hover:border-[#1B2850]/30 hover:shadow-md transition-all group"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="w-12 h-12 rounded-lg bg-[#F5F6FB] flex items-center justify-center group-hover:bg-[#1B2850] transition-colors">
                <UserPlus className="w-6 h-6 text-[#1B2850] group-hover:text-white transition-colors" />
              </div>
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">Waitlist</h3>
            <p className="text-sm text-slate-500 mb-4">
              Approve new members, send invites, manage access
            </p>
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span>{waitlistCount || 0} pending approval</span>
            </div>
          </Link>

          {/* Operations */}
          <Link
            href="/dashboard/admin/operations"
            className="bg-white rounded-xl border border-slate-200 p-6 hover:border-[#1B2850]/30 hover:shadow-md transition-all group"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="w-12 h-12 rounded-lg bg-[#F5F6FB] flex items-center justify-center group-hover:bg-[#1B2850] transition-colors">
                <Wrench className="w-6 h-6 text-[#1B2850] group-hover:text-white transition-colors" />
              </div>
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">Operations</h3>
            <p className="text-sm text-slate-500 mb-4">
              Advanced tools for debugging, manual overrides, and system support.
            </p>
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span>Support &amp; debug tools</span>
            </div>
          </Link>

          {/* Match Inspector */}
          <Link
            href="/dashboard/admin/match-inspector"
            className="bg-white rounded-xl border border-slate-200 p-6 hover:border-[#1B2850]/30 hover:shadow-md transition-all group"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="w-12 h-12 rounded-lg bg-[#F5F6FB] flex items-center justify-center group-hover:bg-[#1B2850] transition-colors">
                <Search className="w-6 h-6 text-[#1B2850] group-hover:text-white transition-colors" />
              </div>
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">Match Inspector</h3>
            <p className="text-sm text-slate-500 mb-4">
              Inspect any pair — relationship state, eligibility, insights, and override tools
            </p>
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span>Pair lookup &amp; manual actions</span>
            </div>
          </Link>

          {/* Issue Reports */}
          <Link
            href="/dashboard/admin/issues"
            className="bg-white rounded-xl border border-slate-200 p-6 hover:border-[#1B2850]/30 hover:shadow-md transition-all group"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="w-12 h-12 rounded-lg bg-[#F5F6FB] flex items-center justify-center group-hover:bg-[#1B2850] transition-colors">
                <AlertCircle className="w-6 h-6 text-[#1B2850] group-hover:text-white transition-colors" />
              </div>
              {(newIssueCount || 0) > 0 ? (
                <span className="text-xs font-semibold px-2 py-1 rounded-full bg-brand-gold-soft text-brand-gold">
                  {newIssueCount} new
                </span>
              ) : null}
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">Issue Reports</h3>
            <p className="text-sm text-slate-500 mb-4">
              User-submitted bug reports and support questions
            </p>
            <div className="flex items-center gap-4 text-xs text-slate-600">
              <span>{(newIssueCount || 0) > 0 ? `${newIssueCount} unreviewed` : 'No new reports'}</span>
            </div>
          </Link>

          {/* Opportunities — read-only metrics card */}
          <div className="bg-white rounded-xl border border-slate-200 p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="w-12 h-12 rounded-lg bg-[#F5F6FB] flex items-center justify-center">
                <Briefcase className="w-6 h-6 text-[#1B2850]" />
              </div>
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-4">Opportunities</h3>
            <div className="space-y-3">
              <div>
                <p className="text-sm text-slate-500">Created (7d)</p>
                <p className="text-2xl font-bold text-slate-900">{opportunitiesCreated7d || 0}</p>
              </div>
              <div>
                <p className="text-sm text-slate-500">Responses (7d)</p>
                <p className="text-2xl font-bold text-slate-900">{opportunityResponses7d || 0}</p>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}
