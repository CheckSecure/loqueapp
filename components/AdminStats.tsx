import { Users, Link2, Calendar, Activity } from 'lucide-react'

interface Stats {
  totalUsers: number
  activeThisWeek: number
  connectionsMade: number
  meetingsBooked: number
}

function StatCard({ icon: Icon, label, value, sub }: { icon: any; label: string; value: number; sub?: string }) {
  return (
    <div className="bg-white border border-slate-100 rounded-xl p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">{label}</p>
        <div className="w-8 h-8 bg-[#FDF3E3] rounded-lg flex items-center justify-center">
          <Icon className="w-4 h-4 text-[#C4922A]" />
        </div>
      </div>
      <p className="text-3xl font-extrabold text-slate-900">{value.toLocaleString()}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  )
}

export default function AdminStats({ stats }: { stats: Stats }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
      <StatCard icon={Users}    label="Total members"    value={stats.totalUsers}       sub="all time" />
      <StatCard icon={Activity} label="Active this week"  value={stats.activeThisWeek}   sub="profile updated" />
      <StatCard icon={Link2}    label="Connections made"  value={stats.connectionsMade}  sub="matched pairs" />
      <StatCard icon={Calendar} label="Meetings booked"   value={stats.meetingsBooked}   sub="all time" />
    </div>
  )
}
