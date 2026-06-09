import { createClient } from '@/lib/supabase/server'
import { parseExpertise } from '@/lib/parseExpertise'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Briefcase, MapPin, BookOpen, Users, Star, MessageSquare, Sparkles, Calendar } from 'lucide-react'
import { computeMatchSignals, toList } from '@/lib/match-signals'
import { EnlargeableAvatar } from '@/components/EnlargeableAvatar'

// Humanizes raw networking-goal values into calmer, reader-facing phrasing.
// Keys cover the values actually present in profiles.purposes; anything not
// listed falls through to the raw value rather than being dropped.
const PURPOSE_LABELS: Record<string, string> = {
  'Find customers': 'Open to business relationships',
  'Business Development': 'Open to business relationships',
  'Hire talent': 'Open to meeting strong talent',
  'Hiring': 'Open to meeting strong talent',
  'Expand network': 'Looking to meet peers',
  'Give back / mentor': 'Interested in mentoring',
  'Mentorship': 'Interested in mentoring',
  'Partnerships': 'Open to partnerships',
  'Learn & grow': 'Looking to learn from experienced professionals',
  'Advice / Expertise': 'Looking for advice and expertise',
  'Raise capital': 'Open to strategic introductions',
  'Fundraising': 'Open to strategic introductions',
  'Explore opportunities': 'Exploring new opportunities',
}

function humanizePurpose(raw: string): string {
  return PURPOSE_LABELS[raw] || raw
}

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
    .select('*')
    .eq('id', params.id)
    .single()

  if (error) console.error('[Profile/[id]] query error:', error.message)
  if (!profile) notFound()

  // Viewer's profile (for computed shared signals) + any active connection
  // between viewer and viewed (for the connection date line).
  const nowIso = new Date().toISOString()
  const [{ data: viewerProfile }, { data: matchRows }, { data: meetingRows }] = await Promise.all([
    supabase
      .from('profiles')
      .select('role_type, seniority, interests, mentorship_role, location, expertise, purposes')
      .eq('id', user.id)
      .maybeSingle(),
    supabase
      .from('matches')
      .select('matched_at, status')
      .or(`and(user_a_id.eq.${user.id},user_b_id.eq.${params.id}),and(user_a_id.eq.${params.id},user_b_id.eq.${user.id})`)
      .neq('status', 'removed')
      .order('matched_at', { ascending: false })
      .limit(1),
    // Past meetings between the two users (agreed and already in the past).
    supabase
      .from('meetings')
      .select('id, purpose, scheduled_at, status')
      .or(`and(requester_id.eq.${user.id},recipient_id.eq.${params.id}),and(requester_id.eq.${params.id},recipient_id.eq.${user.id})`)
      .in('status', ['completed', 'confirmed', 'scheduled'])
      .lt('scheduled_at', nowIso)
      .order('scheduled_at', { ascending: false })
      .limit(5),
  ])

  // "Why connect" — the viewed person's own openness/interests (not computed).
  const whyConnectInterests = toList(profile.interests).slice(0, 8)
  const whyConnectPurposes = toList(profile.purposes)
  const openToMentorship = profile.open_to_mentorship === true
  const openToBusiness = profile.open_to_business_solutions === true
  const hasWhyConnect =
    whyConnectInterests.length > 0 || whyConnectPurposes.length > 0 || openToMentorship || openToBusiness

  // "Why Andrel introduced you" — true shared signals vs the viewer only.
  const match = computeMatchSignals(viewerProfile, profile)

  // Connection date — only when an active match exists between the two users.
  const connection = matchRows && matchRows.length > 0 ? matchRows[0] : null
  const connectedLabel = connection?.matched_at
    ? new Date(connection.matched_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : null
  const pastMeetings = connection ? (meetingRows ?? []) : []

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
    'Executive / C-Suite': 'Executive / C-Suite',
    'Investor / VC': 'Investor / VC',
    'Government / Policy': 'Government / Policy',
    'Finance Professional': 'Finance Professional',
    'Healthcare Professional': 'Healthcare Professional',
  }
  const mentorshipLabel: Record<string, string> = {
    mentor: 'Open to mentoring',
    mentee: 'Looking for a mentor',
    both: 'Mentor & mentee',
    neither: 'Neither',
  }

  const previousRoles: { company: string; title: string; start_date?: string | null; end_date?: string | null }[] =
    Array.isArray(profile.previous_roles)
      ? profile.previous_roles.filter((r: any) => r.company && r.title)
      : []

  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8">
      <div className="max-w-2xl">

        {/* Back navigation */}
        <Link
          href="/dashboard/meetings"
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#1B2850] transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </Link>

        {/* Hero card */}
        <div className="bg-white border border-slate-100 rounded-2xl shadow-sm overflow-hidden mb-6">
          {/* Banner */}
          <div className="h-24 bg-gradient-to-br from-[#1B2850] to-[#2E4080]" />

          <div className="px-6 pb-6">
            {/* Avatar — overlaps banner */}
            <EnlargeableAvatar src={profile.avatar_url} name={name} className="!rounded-2xl -mt-10 mb-4">
              {profile.avatar_url ? (
                <img
                  src={profile.avatar_url}
                  alt={name}
                  className="w-20 h-20 rounded-2xl object-cover border-4 border-white shadow-sm"
                />
              ) : (
                <div className={`w-20 h-20 rounded-2xl ${avatarColor} flex items-center justify-center text-white text-2xl font-bold border-4 border-white shadow-sm`}>
                  {initials(name)}
                </div>
              )}
            </EnlargeableAvatar>

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

          {/* What they're looking for (connected) / Why connect (not yet connected) */}
          {hasWhyConnect && (
            <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-5">
              <Section icon={Users} title={connection ? "What they're looking for" : 'Why connect'}>
                <div className="space-y-3">
                  {whyConnectPurposes.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {whyConnectPurposes.map(p => <Badge key={`p-${p}`} label={humanizePurpose(p)} />)}
                    </div>
                  )}
                  {whyConnectInterests.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {whyConnectInterests.map(i => <Badge key={`i-${i}`} label={i} />)}
                    </div>
                  )}
                  {(openToMentorship || openToBusiness) && (
                    <div className="flex flex-wrap gap-2">
                      {openToMentorship && <Badge label="Open to mentorship" />}
                      {openToBusiness && <Badge label="Open to business opportunities" />}
                    </div>
                  )}
                </div>
              </Section>
            </div>
          )}

          {/* Relationship history — connected profiles only */}
          {connection && (
            <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-5">
              <Section icon={Calendar} title="Relationship history">
                <div className="space-y-2 text-sm text-slate-600">
                  {connectedLabel && <p>Connected through Andrel · {connectedLabel}</p>}
                  {pastMeetings.length > 0 && (
                    <>
                      <p className="text-slate-500">
                        {pastMeetings.length} past {pastMeetings.length === 1 ? 'meeting' : 'meetings'}
                      </p>
                      <ul className="space-y-1">
                        {pastMeetings.map((m: any) => (
                          <li key={m.id}>
                            {m.purpose || 'Meeting'} · {new Date(m.scheduled_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              </Section>
            </div>
          )}

          {/* Why Andrel introduced you — true shared signals only */}
          {match.signals.length > 0 && (
            <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-5">
              <Section icon={Sparkles} title="Why Andrel introduced you">
                {match.hasStrongSignals ? (
                  <div className="flex flex-wrap gap-2">
                    {match.signals.map(s => <Badge key={s} label={s} />)}
                  </div>
                ) : (
                  <div className="text-sm text-slate-600 space-y-1">
                    <p>Curated based on your profile and preferences</p>
                    <p>Additional overlap: {match.sharedInterests.join(', ')}</p>
                  </div>
                )}
              </Section>
            </div>
          )}

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
          {parseExpertise(profile.expertise).length > 0 && (
            <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-5">
              <Section icon={Star} title="Expertise">
                <div className="flex flex-wrap gap-2">
                  {parseExpertise(profile.expertise).map((tag: string) => (
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

          {/* Previous roles */}
          {previousRoles.length > 0 && (
            <div className="bg-white border border-slate-100 rounded-2xl shadow-sm p-5">
              <Section icon={Briefcase} title="Previous Roles">
                <div className="space-y-3">
                  {previousRoles.map((role, i) => (
                    <div key={i} className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-slate-800">{role.title}</p>
                        <p className="text-xs text-slate-500">{role.company}</p>
                      </div>
                      {(role.start_date || role.end_date) && (
                        <p className="text-xs text-slate-400 flex-shrink-0">
                          {[role.start_date, role.end_date].filter(Boolean).join(' – ')}
                        </p>
                      )}
                    </div>
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
