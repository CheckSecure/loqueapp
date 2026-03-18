import { createClient } from '@/lib/supabase/server'
import { Users, Plus, Search, Star, Briefcase, MapPin } from 'lucide-react'

export const metadata = { title: 'Introductions | Cadre' }

const suggestions = [
  {
    name: 'Sarah Chen',
    role: 'Product Lead',
    company: 'Notion',
    location: 'San Francisco, CA',
    mutual: 4,
    tags: ['Product Strategy', 'B2B SaaS', 'Growth'],
    initials: 'SC',
    color: 'bg-violet-500',
  },
  {
    name: 'Marcus Rivera',
    role: 'Engineering Manager',
    company: 'Stripe',
    location: 'Remote',
    mutual: 7,
    tags: ['Fintech', 'Distributed Teams', 'Infra'],
    initials: 'MR',
    color: 'bg-emerald-500',
  },
  {
    name: 'Priya Mehta',
    role: 'VC Investor',
    company: 'Sequoia Capital',
    location: 'Menlo Park, CA',
    mutual: 2,
    tags: ['Early Stage', 'Deep Tech', 'AI/ML'],
    initials: 'PM',
    color: 'bg-amber-500',
  },
  {
    name: 'James O\'Brien',
    role: 'Founder & CEO',
    company: 'Arclight',
    location: 'New York, NY',
    mutual: 5,
    tags: ['Climate Tech', 'Series A', 'Hardware'],
    initials: 'JO',
    color: 'bg-rose-500',
  },
  {
    name: 'Anika Patel',
    role: 'Head of Design',
    company: 'Linear',
    location: 'Amsterdam, NL',
    mutual: 3,
    tags: ['Design Systems', 'Developer Tools', 'UX'],
    initials: 'AP',
    color: 'bg-cyan-500',
  },
  {
    name: 'Derek Lam',
    role: 'GTM Lead',
    company: 'Vercel',
    location: 'Remote',
    mutual: 6,
    tags: ['Enterprise Sales', 'DevEx', 'PLG'],
    initials: 'DL',
    color: 'bg-indigo-500',
  },
]

const pending = [
  { name: 'Taylor Brooks', role: 'Data Scientist at Airbnb', initials: 'TB', color: 'bg-pink-500', daysAgo: 2 },
  { name: 'Lena Fischer', role: 'Principal Engineer at Figma', initials: 'LF', color: 'bg-teal-500', daysAgo: 5 },
]

export default async function IntroductionsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const firstName = (user?.user_metadata?.full_name as string)?.split(' ')[0] || 'there'

  return (
    <div className="p-6 md:p-8 md:pt-8 pt-20">
      <div className="max-w-4xl">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Introductions</h1>
            <p className="text-slate-500 text-sm mt-0.5">Warm connections curated for you, {firstName}.</p>
          </div>
          <button className="flex items-center gap-2 bg-indigo-600 text-white text-sm font-semibold px-4 py-2 rounded-lg hover:bg-indigo-700 transition-colors">
            <Plus className="w-4 h-4" />
            Request intro
          </button>
        </div>

        {/* Pending */}
        {pending.length > 0 && (
          <div className="mb-8">
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Pending requests</h2>
            <div className="space-y-3">
              {pending.map((p) => (
                <div key={p.name} className="bg-white border border-amber-200 rounded-xl p-4 flex items-center justify-between shadow-sm">
                  <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-full ${p.color} flex items-center justify-center text-white text-xs font-bold`}>
                      {p.initials}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{p.name}</p>
                      <p className="text-xs text-slate-500">{p.role}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">{p.daysAgo}d ago</span>
                    <button className="text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-lg transition-colors">Accept</button>
                    <button className="text-xs font-semibold text-slate-600 hover:text-slate-900 px-3 py-1.5 rounded-lg border border-slate-200 hover:border-slate-300 transition-colors">Decline</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Search */}
        <div className="relative mb-6">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search professionals by name, role, or company..."
            className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition"
          />
        </div>

        {/* Suggestions */}
        <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Suggested for you</h2>
        <div className="grid sm:grid-cols-2 gap-4">
          {suggestions.map((s) => (
            <div key={s.name} className="bg-white border border-slate-100 rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-full ${s.color} flex items-center justify-center text-white text-sm font-bold flex-shrink-0`}>
                    {s.initials}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{s.name}</p>
                    <div className="flex items-center gap-1 text-xs text-slate-500">
                      <Briefcase className="w-3 h-3" />
                      <span>{s.role} at {s.company}</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-slate-400">
                      <MapPin className="w-3 h-3" />
                      <span>{s.location}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 text-xs text-slate-400">
                  <Users className="w-3 h-3" />
                  <span>{s.mutual}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {s.tags.map((tag) => (
                  <span key={tag} className="text-xs bg-slate-50 text-slate-600 border border-slate-100 px-2 py-0.5 rounded-full">{tag}</span>
                ))}
              </div>
              <div className="flex gap-2 pt-1">
                <button className="flex-1 text-xs font-semibold bg-indigo-600 text-white py-1.5 rounded-lg hover:bg-indigo-700 transition-colors">
                  Request intro
                </button>
                <button className="px-3 py-1.5 rounded-lg border border-slate-200 hover:border-slate-300 transition-colors">
                  <Star className="w-3.5 h-3.5 text-slate-400" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
