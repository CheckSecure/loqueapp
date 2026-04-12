
'use client'

import { useState, useMemo } from 'react'
import { Search, Filter, UserPlus, Zap, Edit, CheckCircle, AlertTriangle, Users, TrendingUp } from 'lucide-react'
import { adminForceMatch, adminUpdateUser } from '@/app/actions'
import { useRouter } from 'next/navigation'

interface Profile {
  id: string
  full_name: string | null
  email: string | null
  company: string | null
  title: string | null
  tier: string | null
  location: string | null
  boost_score: number
  is_priority: boolean
  account_status: string
  verification_status: string
  current_status: string
  profile_complete: boolean
  created_at: string
  credits: number
  matches: number
  pending_intros: number
  active_intros: number
}

export default function AdminMembersClient({ profiles }: { profiles: Profile[] }) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [filterTier, setFilterTier] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [filterVerification, setFilterVerification] = useState<string>('')
  const [showStuckOnly, setShowStuckOnly] = useState(false)
  const [selectedUser, setSelectedUser] = useState<Profile | null>(null)
  const [showForceMatch, setShowForceMatch] = useState(false)
  const [matchUserA, setMatchUserA] = useState<string>('')
  const [matchUserB, setMatchUserB] = useState<string>('')
  const [saving, setSaving] = useState(false)

  // Filtered profiles
  const filtered = useMemo(() => {
    console.log('[AdminMembers] Filtering. showStuckOnly:', showStuckOnly, 'Total profiles:', profiles.length)
    let result = profiles

    if (search) {
      const s = search.toLowerCase()
      result = result.filter(p => 
        p.full_name?.toLowerCase().includes(s) ||
        p.email?.toLowerCase().includes(s) ||
        p.company?.toLowerCase().includes(s)
      )
    }

    if (filterTier) result = result.filter(p => p.tier === filterTier)
    if (filterStatus) result = result.filter(p => p.account_status === filterStatus)
    if (filterVerification) result = result.filter(p => p.verification_status === filterVerification)

    // Stuck user filter: no matches AND no active intros
    if (showStuckOnly) {
      result = result.filter(p => 
        p.matches === 0 && p.pending_intros === 0 && p.active_intros === 0
      )
    }

    return result
  }, [profiles, search, filterTier, filterStatus, filterVerification, showStuckOnly])

  const handleForceMatch = async () => {
    if (!matchUserA || !matchUserB) return
    setSaving(true)
    const result = await adminForceMatch(matchUserA, matchUserB, true)
    setSaving(false)
    if (result.success) {
      setShowForceMatch(false)
      setMatchUserA('')
      setMatchUserB('')
      router.refresh()
    } else {
      alert(result.error)
    }
  }

  const handleQuickEdit = async (userId: string, field: string, value: any) => {
    const updates: any = { [field]: value }
    const result = await adminUpdateUser(userId, updates)
    if (result.success) {
      router.refresh()
    } else {
      alert(result.error)
    }
  }

  const stuckUsers = profiles.filter(p => p.matches === 0 && p.pending_intros === 0 && p.active_intros === 0)

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Members</h1>
            <p className="text-sm text-slate-500 mt-1">{filtered.length} of {profiles.length} users</p>
          </div>
          <button
            onClick={() => setShowForceMatch(true)}
            className="flex items-center gap-2 px-4 py-2 bg-[#1B2850] text-white text-sm font-semibold rounded-lg hover:bg-[#162040]"
          >
            <UserPlus className="w-4 h-4" />
            Force Match
          </button>
        </div>

        {/* Stuck Users Alert */}
        {stuckUsers.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600" />
                <div>
                  <p className="text-sm font-semibold text-amber-900">{stuckUsers.length} stuck users need attention</p>
                  <p className="text-xs text-amber-700 mt-0.5">No matches or no active introductions</p>
                </div>
              </div>
              <button
                onClick={() => {
                  console.log('[AdminMembers] Toggling stuck filter. Current:', showStuckOnly, '-> New:', !showStuckOnly)
                  setShowStuckOnly(!showStuckOnly)
                }}
                className="px-3 py-1.5 bg-amber-600 text-white text-xs font-medium rounded-lg hover:bg-amber-700"
              >
                {showStuckOnly ? 'Show All' : 'Show Stuck Only'}
              </button>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                placeholder="Search name, email, company..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20"
              />
            </div>
            <select
              value={filterTier}
              onChange={e => setFilterTier(e.target.value)}
              className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20"
            >
              <option value="">All Tiers</option>
              <option value="platinum">Platinum</option>
              <option value="gold">Gold</option>
              <option value="silver">Silver</option>
              <option value="bronze">Bronze</option>
            </select>
            <select
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
              className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20"
            >
              <option value="">All Status</option>
              <option value="active">Active</option>
              <option value="deactivated">Deactivated</option>
              <option value="flagged">Flagged</option>
            </select>
            <select
              value={filterVerification}
              onChange={e => setFilterVerification(e.target.value)}
              className="px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#1B2850]/20"
            >
              <option value="">All Verification</option>
              <option value="verified">Verified</option>
              <option value="unverified">Unverified</option>
              <option value="pending">Pending</option>
            </select>
          </div>
        </div>

        {/* User List */}
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">User</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Tier</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Status</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-600">Matches</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-600">Intros</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-600">Credits</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-slate-600">Boost</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map(user => (
                  <tr key={user.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full bg-[#1B2850] text-white flex items-center justify-center text-xs font-semibold">
                          {user.full_name?.[0] || user.email?.[0] || '?'}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-slate-900">{user.full_name || 'Unnamed'}</p>
                          <p className="text-xs text-slate-500">{user.title} {user.company && `• ${user.company}`}</p>
                        </div>
                        {user.is_priority && (
                          <Zap className="w-4 h-4 text-amber-500" />
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={user.tier || 'bronze'}
                        onChange={e => handleQuickEdit(user.id, 'tier', e.target.value)}
                        className="px-2 py-1 text-xs border border-slate-200 rounded"
                      >
                        <option value="platinum">Platinum</option>
                        <option value="gold">Gold</option>
                        <option value="silver">Silver</option>
                        <option value="bronze">Bronze</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-medium ${
                        user.account_status === 'active' ? 'bg-green-100 text-green-700' :
                        user.account_status === 'flagged' ? 'bg-red-100 text-red-700' :
                        'bg-slate-100 text-slate-700'
                      }`}>
                        {user.account_status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center text-sm font-medium text-slate-900">
                      {user.matches}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="text-xs text-slate-600">
                        {user.active_intros} active / {user.pending_intros} pending
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <input
                        type="number"
                        value={user.credits}
                        onChange={e => handleQuickEdit(user.id, 'credits', parseInt(e.target.value))}
                        className="w-16 px-2 py-1 text-xs text-center border border-slate-200 rounded"
                      />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <input
                        type="number"
                        value={user.boost_score}
                        onChange={e => handleQuickEdit(user.id, 'boost_score', parseInt(e.target.value))}
                        className="w-16 px-2 py-1 text-xs text-center border border-slate-200 rounded"
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setSelectedUser(user)}
                        className="text-sm text-[#1B2850] hover:underline"
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Force Match Modal */}
        {showForceMatch && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl p-6 max-w-md w-full">
              <h2 className="text-lg font-bold text-slate-900 mb-4">Force Match</h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">User A</label>
                  <select
                    value={matchUserA}
                    onChange={e => setMatchUserA(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg"
                  >
                    <option value="">Select user...</option>
                    {profiles.map(p => (
                      <option key={p.id} value={p.id}>{p.full_name} ({p.email})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">User B</label>
                  <select
                    value={matchUserB}
                    onChange={e => setMatchUserB(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg"
                  >
                    <option value="">Select user...</option>
                    {profiles.filter(p => p.id !== matchUserA).map(p => (
                      <option key={p.id} value={p.id}>{p.full_name} ({p.email})</option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-3 pt-4">
                  <button
                    onClick={handleForceMatch}
                    disabled={!matchUserA || !matchUserB || saving}
                    className="flex-1 px-4 py-2 bg-[#1B2850] text-white text-sm font-semibold rounded-lg hover:bg-[#162040] disabled:opacity-50"
                  >
                    {saving ? 'Creating...' : 'Create Match'}
                  </button>
                  <button
                    onClick={() => setShowForceMatch(false)}
                    className="px-4 py-2 border border-slate-200 text-sm font-medium rounded-lg hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Quick Edit Modal */}
        {selectedUser && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl p-6 max-w-md w-full max-h-[90vh] overflow-y-auto">
              <h2 className="text-lg font-bold text-slate-900 mb-4">Edit User</h2>
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900">{selectedUser.full_name}</p>
                  <p className="text-xs text-slate-500">{selectedUser.email}</p>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Tier</label>
                  <select
                    value={selectedUser.tier || 'bronze'}
                    onChange={e => handleQuickEdit(selectedUser.id, 'tier', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  >
                    <option value="platinum">Platinum</option>
                    <option value="gold">Gold</option>
                    <option value="silver">Silver</option>
                    <option value="bronze">Bronze</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Account Status</label>
                  <select
                    value={selectedUser.account_status}
                    onChange={e => handleQuickEdit(selectedUser.id, 'account_status', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  >
                    <option value="active">Active</option>
                    <option value="deactivated">Deactivated</option>
                    <option value="flagged">Flagged</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Verification Status</label>
                  <select
                    value={selectedUser.verification_status}
                    onChange={e => handleQuickEdit(selectedUser.id, 'verification_status', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  >
                    <option value="verified">Verified</option>
                    <option value="unverified">Unverified</option>
                    <option value="pending">Pending</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Current Status</label>
                  <select
                    value={selectedUser.current_status}
                    onChange={e => handleQuickEdit(selectedUser.id, 'current_status', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  >
                    <option value="employed">Employed</option>
                    <option value="between_roles">Between Roles</option>
                    <option value="consulting_advisory">Consulting/Advisory</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Credits</label>
                  <input
                    type="number"
                    value={selectedUser.credits}
                    onChange={e => handleQuickEdit(selectedUser.id, 'credits', parseInt(e.target.value))}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Boost Score</label>
                  <input
                    type="number"
                    value={selectedUser.boost_score}
                    onChange={e => handleQuickEdit(selectedUser.id, 'boost_score', parseInt(e.target.value))}
                    className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selectedUser.is_priority}
                    onChange={e => handleQuickEdit(selectedUser.id, 'is_priority', e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <label className="text-sm text-slate-700">Priority User</label>
                </div>

                <div className="flex gap-3 pt-4">
                  <button
                    onClick={() => setSelectedUser(null)}
                    className="flex-1 px-4 py-2 border border-slate-200 text-sm font-medium rounded-lg hover:bg-slate-50"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
