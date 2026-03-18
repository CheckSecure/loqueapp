import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Briefcase, MapPin, BookOpen, Users, Star, MessageSquare } from 'lucide-react'

const AVATAR_COLORS = [
  'bg-[#1B2850]', 'bg-[#2E4080]', 'bg-amber-500', 'bg-rose-500',
  'bg-cyan-600', 'bg-teal-600', 'bg-pink-500', 'bg-slate-600',
]
function pickColor(id?: string) {
  if (!id) return 'bg-[#1B2850]'
  const n = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return AVATAR_COLORS[n % AVATAR_COLORS.length]
}
function initials(name?: string) {
  return name?.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase() || '?'
}

function Badge({ label }: { label: string }) {
  return (
    <span className="inline-block text-xs font-medium bg-[#F5F6FB] text-[#1B2850] px-3 py-1.5 rounded-full border border-slate-100">
      {label}
    </span>
  )
}

function Section({ icon: Icon, title, children }: {
  icon: React.ElementType
  title: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Icon className="w-4 h-4 text-[#C4922A]" />
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">{title}</h3>
      </div>
      {children}
    </div>
  )
}

export default async function MemberProfilePage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  if (params.id === user.id) redirect('/dashboard/profile')

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('id, full_name, title, company, location, bio, expertise, intro_preferences, open_to_intros, seniority, role_type, mentorship_role')
    .eq('id', params.id)
    .single()

  if (error || !profile) notFound()

  const avatarColor = pickColor(profile.id)
  const name = profile.full_name || 'Member'

  const seniorityLabel: Record<string, string> = {
    ic: 'Individual Contributor',
    manager: 'Manager',
    director: 'Director',
    vp: 'VP',
    c_suite: 'C-Suite / Executive',
    founder: 'Founder',
    partner: 'Partner',
  }
  const roleTypeLabel: Record<string, string> = {
    legal: 'Legal',
    compliance: 'Compliance',
    risk: 'Risk',
    privacy: 'Privacy',
    regulatory: 'Regulatory Affairs',
    government: 'Government Affairs',
    other: 'Other',
  }
  const mentorshipLabel: Record<string, string> = {
    mentor: 'Open to mentoring',
    mentee: 'Looking for a mentor',
    both: 'Mentor & mentee',
    neither: 'Neither',
  }

  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="max-w-2xl">

        {/* Back navigation */}
        <Link
          href="/dashboard/meetings"
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#1B2850] transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to meetings
        </Link>

        {/* Hero card */}
        <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden mb-6">
          {/* Banner */}
          <div className="h-24 bg-gradient-to-br from-[#1B2850] to-[#2E4080]" />

          <div className="px-6 pb-6">
            {/* Avatar — overlaps banner */}
            <div className={`w-20 h-20 rounded-2xl ${avatarColor} flex items-center justify-center text-white text-2xl font-bold border-4 border-white shadow-sm -mt-10 mb-4`}>
              {initials(name)}
            </div>

            <h1 className="text-xl font-bold text-slate-900">{name}</h1>

            {(profile.title || profile.company) && (
              <p className="text-sm text-slate-600 mt-1 flex items-center gap-1.5">
                <Briefcase className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                {[profile.title, profile.company].filter(Boolean).join(' · ')}
              </p>
            )}

            {profile.location && (
              <p className="text-sm text-slate-500 mt-1 flex items-center gap-1.5">
                <MapPin className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                {profile.location}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-5">

          {/* Bio */}
          {profile.bio && (
            <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-5">
              <Section icon={BookOpen} title="About">
                <p className="text-sm text-slate-700 leading-relaxed">{profile.bio}</p>
              </Section>
            </div>
          )}

          {/* Role details */}
          {(profile.seniority || profile.role_type || profile.mentorship_role) && (
            <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-5">
              <Section icon={Users} title="Professional details">
                <dl className="space-y-3">
                  {profile.seniority && (
                    <div className="flex items-start justify-between gap-4">
                      <dt className="text-xs text-slate-500 flex-shrink-0 pt-0.5">Seniority</dt>
                      <dd className="text-sm font-medium text-slate-800 text-right">
                        {seniorityLabel[profile.seniority] ?? profile.seniority}
                      </dd>
                    </div>
                  )}
                  {profile.role_type && (
                    <div className="flex items-start justify-between gap-4">
                      <dt className="text-xs text-slate-500 flex-shrink-0 pt-0.5">Role type</dt>
                      <dd className="text-sm font-medium text-slate-800 text-right">
                        {roleTypeLabel[profile.role_type] ?? profile.role_type}
                      </dd>
                    </div>
                  )}
                  {profile.mentorship_role && (
                    <div className="flex items-start justify-between gap-4">
                      <dt className="text-xs text-slate-500 flex-shrink-0 pt-0.5">Mentorship</dt>
                      <dd className="text-sm font-medium text-slate-800 text-right">
                        {mentorshipLabel[profile.mentorship_role] ?? profile.mentorship_role}
                      </dd>
                    </div>
                  )}
                </dl>
              </Section>
            </div>
          )}

          {/* Expertise */}
          {Array.isArray(profile.expertise) && profile.expertise.length > 0 && (
            <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-5">
              <Section icon={Star} title="Expertise">
                <div className="flex flex-wrap gap-2">
                  {profile.expertise.map((tag: string) => (
                    <Badge key={tag} label={tag} />
                  ))}
                </div>
              </Section>
            </div>
          )}

          {/* Introduction interests */}
          {Array.isArray(profile.intro_preferences) && profile.intro_preferences.length > 0 && (
            <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-5">
              <Section icon={MessageSquare} title="Open to introductions with">
                <div className="flex flex-wrap gap-2">
                  {profile.intro_preferences.map((tag: string) => (
                    <Badge key={tag} label={tag} />
                  ))}
                </div>
              </Section>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
