import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Users, GitBranch, UserPlus, Inbox, TrendingUp, MessageSquare, Calendar, Network } from 'lucide-react'

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

  const { count: pendingIntros } = await supabase
    .from('intro_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')

  const { count: waitlistCount } = await supabase
    .from('waitlist')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')

  const { count: activeWeekCount } = await supabase
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .gte('updated_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

  // Get current batch info
  const { data: currentBatch } = await supabase
    .from('batches')
    .select('id, created_at, approved_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

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
            <p className="text-xs text-slate-500 mt-1">Total Members</p>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-center justify-between mb-2">
              <Network className="w-5 h-5 text-green-600" />
              <span className="text-xs text-slate-500">All time</span>
            </div>
            <p className="text-3xl font-bold text-slate-900">{totalMatches || 0}</p>
            <p className="text-xs text-slate-500 mt-1">Connections Made</p>
          </div>

          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="flex items-center justify-between mb-2">
              <Calendar className="w-5 h-5 text-blue-600" />
              <span className="text-xs text-slate-500">All time</span>
            </div>
            <p className="text-3xl font-bold text-slate-900">{totalMeetings || 0}</p>
            <p className="text-xs text-slate-500 mt-1">Meetings Booked</p>
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
              {(pendingIntros || 0) > 0 && <span className="text-amber-600 font-medium">{pendingIntros} pending intros</span>}
            </div>
          </Link>

          {/* Batch Management */}
          <Link
            href="/dashboard/admin#batches"
            className="bg-white rounded-xl border border-slate-200 p-6 hover:border-[#1B2850]/30 hover:shadow-md transition-all group"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="w-12 h-12 rounded-lg bg-[#F5F6FB] flex items-center justify-center group-hover:bg-[#1B2850] transition-colors">
                <GitBranch className="w-6 h-6 text-[#1B2850] group-hover:text-white transition-colors" />
              </div>
              {!currentBatch?.approved_at && (
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

          {/* Intro Requests */}
          <Link
            href="/dashboard/admin#intros"
            className="bg-white rounded-xl border border-slate-200 p-6 hover:border-[#1B2850]/30 hover:shadow-md transition-all group"
          >
            <div className="flex items-start justify-between mb-4">
              <div className="w-12 h-12 rounded-lg bg-[#F5F6FB] flex items-center justify-center group-hover:bg-[#1B2850] transition-colors">
                <Inbox className="w-6 h-6 text-[#1B2850] group-hover:text-white transition-colors" />
              </div>
              {(pendingIntros || 0) > 0 && (
                <span className="px-2 py-1 bg-red-100 text-red-700 text-xs font-medium rounded">
                  {pendingIntros} pending
                </span>
              )}
            </div>
            <h3 className="text-lg font-bold text-slate-900 mb-2">Intro Requests</h3>
            <p className="text-sm text-slate-500 mb-4">
              Review and approve member-initiated introduction requests
            </p>
          </Link>

          {/* Waitlist */}
          <Link
            href="/dashboard/admin#waitlist"
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

        </div>
      </div>
    </div>
  )
}
