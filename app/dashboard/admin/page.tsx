import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import {
  Users, GitBranch, UserPlus, TrendingUp, Search, Wrench, AlertCircle, Sparkles,
  Building2, Network, Mail, Send, Activity, ShieldAlert, ChevronRight, CircleAlert,
} from 'lucide-react'
import { loadAdminDashboard } from '@/lib/admin/dashboardData'

export const metadata = { title: 'Admin Dashboard | Andrel' }
// Admin-only + never cached: this page renders one operator's sensitive operational data.
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

// ── Presentational primitives (server components; no client JS) ──────────────────────
type Tone = 'neutral' | 'red' | 'amber' | 'sky'
const dotCls: Record<'high' | 'medium' | 'low', string> = { high: 'bg-red-500', medium: 'bg-amber-500', low: 'bg-sky-400' }
const accentCls: Record<Tone, string> = {
  neutral: 'border-slate-200', red: 'border-red-300', amber: 'border-amber-300', sky: 'border-sky-200',
}

/** Compact metric card. `tip` becomes an accessible tooltip (numerator/denominator/timeframe/rules). */
function Stat({ label, value, tip, sub, href, tone = 'neutral' }: {
  label: string; value: string | number; tip: string; sub?: string | null; href?: string; tone?: Tone
}) {
  const inner = (
    <div className={`h-full bg-white rounded-xl border ${accentCls[tone]} p-4`} title={tip} aria-label={`${label}: ${value}. ${tip}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-2xl font-bold text-slate-900 leading-none">{value}</p>
        <span className="text-slate-300" aria-hidden="true">ⓘ</span>
      </div>
      <p className="text-[11px] text-slate-500 mt-1.5 leading-tight">{label}</p>
      {sub != null && <p className="text-[11px] text-slate-400 mt-0.5 leading-tight">{sub}</p>}
      {href && <p className="text-[11px] text-[#1B2850] mt-1 font-medium">View →</p>}
    </div>
  )
  return href ? <Link href={href} className="block hover:opacity-90 transition-opacity">{inner}</Link> : inner
}

function SectionHeader({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between mb-2">
      <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">{title}</h2>
      {note && <span className="text-[11px] text-slate-400">{note}</span>}
    </div>
  )
}

function Unavailable({ label }: { label: string }) {
  return <div className="bg-white rounded-xl border border-slate-200 p-4"><p className="text-sm text-slate-400">{label}: unavailable</p></div>
}

export default async function AdminDashboard() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  const adminClient = createAdminClient()
  const now = Date.now()

  // Single consolidated load: the loader owns the shared fetch, operational counts, and the
  // (cached) migration-health check — invoked EXACTLY ONCE here, so no data loader runs twice.
  const dash = await loadAdminDashboard(adminClient, {
    now,
    adminEmail: user.email, // loader re-checks admin authorization (defense-in-depth)
    env: { deployedSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null },
  })
  const { waitlistPending, concierge: pendingConciergeCount, issues: newIssueCount } = dash.operational

  const inv = dash.invitations
  const rec = dash.recommendations
  const mem = dash.members
  const p = dash.platform

  const navLinks: Array<{ href: string; label: string; icon: any; badge?: number }> = [
    { href: '/dashboard/admin/waitlist', label: 'Waitlist', icon: UserPlus, badge: waitlistPending ?? 0 },
    { href: '/dashboard/admin/batches', label: 'Batches', icon: GitBranch },
    { href: '/dashboard/admin/members', label: 'Members', icon: Users },
    { href: '/dashboard/admin/concierge', label: 'Concierge', icon: Sparkles, badge: pendingConciergeCount ?? 0 },
    { href: '/dashboard/admin/match-inspector', label: 'Match Inspector', icon: Search },
    { href: '/dashboard/admin/operations', label: 'Operations', icon: Wrench },
    { href: '/dashboard/admin/issues', label: 'Issue Reports', icon: AlertCircle, badge: newIssueCount ?? 0 },
    { href: '/dashboard/admin/companies', label: 'Companies', icon: Building2 },
    { href: '/dashboard/admin/metrics', label: 'Launch Metrics', icon: TrendingUp },
    { href: '/dashboard/admin/referral-campaign', label: 'Referral Campaign', icon: Network },
  ]

  return (
    <div className="min-h-screen bg-slate-50 p-5 sm:p-6 lg:px-8">
      <div className="max-w-content mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Admin Dashboard</h1>
          <p className="text-sm text-slate-500 mt-0.5">Launch operations console</p>
        </div>

        {/* 1 ── NEEDS ATTENTION (first) ─────────────────────────────────────────────── */}
        <div>
          <SectionHeader title="Needs Attention" note={`${dash.needsAttention.length} item${dash.needsAttention.length === 1 ? '' : 's'}`} />
          <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
            {dash.needsAttention.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-500">No actionable items right now. Monitoring gaps below are informational.</p>
            ) : dash.needsAttention.map((item) => (
              <Link key={item.id} href={item.href} className="flex items-start gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors" title={item.explanation}>
                <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${dotCls[item.severity]}`} aria-hidden="true" />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800">{item.title}</span>
                    <span className="text-[11px] font-semibold text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">{item.count}</span>
                  </span>
                  <span className="block text-[11px] text-slate-500 mt-0.5 leading-tight">{item.explanation}</span>
                </span>
                <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0 mt-1" aria-hidden="true" />
              </Link>
            ))}
          </div>
          {/* Monitoring gaps — honestly surfaced, never a fake-green status. */}
          <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-2.5">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Monitoring not connected</p>
            <ul className="space-y-1">
              {dash.monitoringGaps.map((g) => (
                <li key={g.id} className="text-[11px] text-slate-500 flex items-start gap-1.5">
                  <CircleAlert className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-px" aria-hidden="true" />
                  <span><span className="font-medium text-slate-600">{g.label}:</span> {g.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* 2 ── INVITATIONS & ACTIVATION ────────────────────────────────────────────── */}
        <div>
          <SectionHeader title="Invitations & Activation" note="counts unique people, not attempts" />
          {!inv.ok ? <Unavailable label="Invitation metrics" /> : (
            <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Awaiting review" value={inv.data.awaitingReview} href="/dashboard/admin/waitlist" tip="Waitlist entries with status 'pending' — applicants awaiting an approval decision." />
              <Stat label="Invited (people)" value={inv.data.invited} href="/dashboard/admin/waitlist" tip="Unique invited invitees: waitlist entries with status 'invited' and a non-null invited_at." />
              <Stat label="Delivery pending (people)" value={inv.data.deliveryPending} tone={inv.data.deliveryStuck > 0 ? 'amber' : 'neutral'} href="/dashboard/admin/waitlist" tip={`Unique invitees whose CURRENT delivery state is in-flight (claimed/accepted/deferred). ${inv.data.deliveryStuck} stuck > ${24}h.`} sub={inv.data.deliveryStuck > 0 ? `${inv.data.deliveryStuck} stuck` : null} />
              <Stat label="Delivered (people)" value={inv.data.delivered} tip="Unique invitees whose CURRENT collapsed state is 'delivered' (a later resend can flip an earlier bounce to delivered)." />
              <Stat label="Bounced / blocked / failed (people)" value={inv.data.failed} tone={inv.data.failed > 0 ? 'red' : 'neutral'} href="/dashboard/admin/waitlist" tip="Unique invitees whose CURRENT state is terminal-failure (bounced/blocked/complained/failed) — a later bounce after a delivery counts here." />
              <Stat label="Activated (people)" value={inv.data.activated ?? '—'} tone={inv.data.activationAvailable ? 'neutral' : 'amber'} tip="Unique DELIVERED invitees who have signed in (auth last_sign_in_at not null). Denominator of conversion = unique delivered invitees." sub={!inv.data.activationAvailable ? 'unavailable (Auth listing incomplete)' : inv.data.conversionRate != null ? `${inv.data.conversionRate}% of delivered` : null} />
              <Stat label="Not activated 24h / 3d / 7d" value={inv.data.activationAvailable ? `${inv.data.notActivated24h} / ${inv.data.notActivated3d} / ${inv.data.notActivated7d}` : 'unavailable'} tone={(inv.data.notActivated7d ?? 0) > 0 ? 'amber' : 'neutral'} tip="Unique delivered invitees, delivered ≥24h/3d/7d ago, never signed in (cumulative). Unavailable when the Auth listing is incomplete." />
              <Stat label="Historical (status unknown)" value={inv.data.historicalUnknown} tip="Invited invitees with NO delivery record (pre-tracking sends) — delivery status is genuinely unavailable, not a failure." />
            </div>
            <p className="mt-2 text-[11px] text-slate-400">
              Attempts (operational, not people): {inv.data.attempts.total} total · {inv.data.attempts.delivered} delivered · {inv.data.attempts.failed} failed
              {Object.entries(inv.data.attempts.byPurpose).length > 0 && <> · {Object.entries(inv.data.attempts.byPurpose).map(([k, v]) => `${v} ${k}`).join(' · ')}</>}
              {inv.data.unattributableAttempts > 0 && <> · {inv.data.unattributableAttempts} unattributable</>}
              {inv.data.manualReview > 0 && <> · <span className="text-amber-600">{inv.data.manualReview} manual-review (email reassigned)</span></>}
            </p>
            </>
          )}
        </div>

        {/* 3 ── RECOMMENDATIONS & MATCHING ──────────────────────────────────────────── */}
        <div>
          <SectionHeader title="Recommendations & Matching" />
          {!rec.ok ? <Unavailable label="Recommendation metrics" /> : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Eligible without a recommendation" value={rec.data.eligibleWithoutRec} tone={rec.data.eligibleWithoutRec > 0 ? 'amber' : 'neutral'} href="/dashboard/admin/batches" tip="Eligible members (active, complete, non-test/non-admin) with zero active suggestion cards (status suggested/queued)." />
              <Stat label="Reciprocal pairs created" value={rec.data.reciprocalPairsCreated} tip="Total member_pairs rows — canonical two-person auto-introduction pairs created all-time." />
              <Stat label="Active reciprocal suggestions" value={rec.data.activeReciprocalSuggestions} tip="Directional intro_requests cards with a pair_id and status 'suggested' (both sides of a live pair)." />
              <Stat label="One-sided legacy suggestions" value={rec.data.oneSidedLegacySuggestions} tone={rec.data.oneSidedLegacySuggestions > 0 ? 'sky' : 'neutral'} tip="Suggested intro_requests with NO pair_id — legacy batch-model one-directional cards." />
              <Stat label="Members at capacity" value={rec.data.membersAtCapacity} tip="Eligible members holding the maximum 2 VISIBLE cards (status suggested). Reserved 'queued' cards are a separate tier and do not count toward this."  />
              <Stat label="Pairs nearing rotation" value={rec.data.nearingRotation} tip={`Active pairs last recommended ${11}–${14} days ago — due to rotate soon.`} />
              <Stat label="Pairs overdue for rotation" value={rec.data.staleOverdue} tone={rec.data.staleOverdue > 0 ? 'amber' : 'neutral'} href="/dashboard/admin/operations" tip={`Active pairs untouched > ${14} days — rotation should have expired them.`} />
              <Stat label="Interest expressed" value={rec.data.interestExpressed} tip="intro_requests in an expressed-interest status (pending/accepted/admin_pending/approved)." />
              <Stat label="Mutual matches" value={rec.data.mutualMatches} href="/dashboard/admin/match-inspector" tip="Unique canonical matched pairs (active, not removed) — reverse rows de-duplicated." />
              <Stat label="Upcoming meetings (from matches)" value={rec.data.upcomingMeetingsFromMatches} tip="Future meetings (scheduled/confirmed/requested) whose two participants form a matched pair." />
              <Stat label="Exposure — median / max inbound" value={`${rec.data.exposure.median} / ${rec.data.exposure.max}`} tone={rec.data.exposure.concentrationAlert ? 'red' : 'neutral'} tip="Median and highest inbound active-suggestion count across eligible members. Alert if the top is ≥4 and ≥3× the median." sub={rec.data.exposure.concentrationAlert ? 'concentration alert' : null} />
            </div>
          )}
        </div>

        {/* 4 ── MEMBERS & ENGAGEMENT ────────────────────────────────────────────────── */}
        <div>
          <SectionHeader title="Members & Engagement" note="7-day windows" />
          {!mem.ok ? <Unavailable label="Member metrics" /> : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Total members" value={mem.data.totalMembers} tip="Real people: profiles EXCLUDING test accounts and admin. The superset — Active is a subset." />
              <Stat label="Active members" value={mem.data.activeMembers} tip="Real members with account_status = 'active'. Subset of Total members (same excluded populations)." />
              <Stat label="Onboarding incomplete" value={mem.data.onboardingIncomplete} tone={mem.data.onboardingIncomplete > 0 ? 'sky' : 'neutral'} tip="Real active members with profile_complete = false — not yet eligible for matching." />
              <Stat label="Active last 7 days" value={mem.data.activeLast7d} tip="Real active members with member_presence last_active_at within 7 days. Numerator ⊆ Active members." sub={mem.data.weeklyActivePct != null ? `${mem.data.weeklyActivePct}% of active members` : null} />
              <Stat label="Active connections (unique pairs)" value={mem.data.activeConnections} tip="Unique canonical matched pairs (active, not removed) — labeled as pairs, not match rows." />
              <Stat label="Messages sent (7d)" value={mem.data.messages7d} tip="Non-system messages created in the last 7 days." />
              <Stat label="Meetings created (7d)" value={mem.data.meetingsCreated7d} tip="meetings rows created in the last 7 days (all statuses)." />
              <Stat label="Upcoming meetings" value={mem.data.upcomingMeetings} tip="Meetings with scheduled_at in the future and status requested/scheduled/confirmed." />
            </div>
          )}
        </div>

        {/* 5 ── PLATFORM HEALTH ─────────────────────────────────────────────────────── */}
        <div>
          <SectionHeader title="Platform Health" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {/* Migrations */}
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><GitBranch className="w-4 h-4 text-slate-400" /><p className="text-xs font-semibold text-slate-600">Schema migrations</p></div>
              {p.migration == null ? <p className="text-sm text-slate-400">Unavailable</p> : p.migration.ok ? (
                <p className="text-sm text-emerald-600 font-medium">All applied</p>
              ) : (
                <div>
                  <p className="text-sm text-amber-600 font-medium">{p.migration.pending.length} pending</p>
                  <ul className="mt-1 space-y-0.5">
                    {p.migration.pending.map((m) => (
                      <li key={m.migration} className="text-[11px] text-slate-500 truncate" title={m.impact}>{m.migration}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            {/* Webhook health */}
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><Mail className="w-4 h-4 text-slate-400" /><p className="text-xs font-semibold text-slate-600">Invitation webhook (7d)</p></div>
              {!p.webhook.ok ? <p className="text-sm text-slate-400">Unavailable</p> : (
                <p className={`text-sm font-medium ${p.webhook.data.errorEvents > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                  {p.webhook.data.totalEvents} events · {p.webhook.data.errorEvents} errors
                </p>
              )}
            </div>
            {/* Deployed SHA */}
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><Activity className="w-4 h-4 text-slate-400" /><p className="text-xs font-semibold text-slate-600">Deployed commit</p></div>
              <p className="text-sm font-mono text-slate-700">{p.deployedSha ? p.deployedSha.slice(0, 7) : 'Unavailable (local)'}</p>
            </div>
            {/* Auth listing completeness — activation figures depend on a COMPLETE Auth scan */}
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><Users className="w-4 h-4 text-slate-400" /><p className="text-xs font-semibold text-slate-600">Auth activation source</p></div>
              <p className={`text-sm font-medium ${dash.activation.complete ? 'text-emerald-600' : 'text-amber-600'}`}>
                {dash.activation.complete ? `Complete · ${dash.activation.pages} page${dash.activation.pages === 1 ? '' : 's'}` : 'Incomplete — activation figures unavailable'}
              </p>
            </div>
            {/* Cron / Auth / Supabase — no supported live source → honest "Not connected" + link */}
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><Send className="w-4 h-4 text-slate-400" /><p className="text-xs font-semibold text-slate-600">Weekly cron</p></div>
              <p className="text-sm text-slate-400">Not connected</p>
              <a href="https://vercel.com/dashboard" className="text-[11px] text-[#1B2850] font-medium">Vercel cron logs →</a>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><ShieldAlert className="w-4 h-4 text-slate-400" /><p className="text-xs font-semibold text-slate-600">Auth / service 5xx</p></div>
              <p className="text-sm text-slate-400">Not connected</p>
              <a href="https://vercel.com/dashboard" className="text-[11px] text-[#1B2850] font-medium">Runtime logs →</a>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><Activity className="w-4 h-4 text-slate-400" /><p className="text-xs font-semibold text-slate-600">Supabase resources</p></div>
              <p className="text-sm text-slate-400">Not connected</p>
              <a href="https://supabase.com/dashboard" className="text-[11px] text-[#1B2850] font-medium">Supabase dashboard →</a>
            </div>
          </div>
        </div>

        {/* 6 ── COMPACT NAV LINKS ───────────────────────────────────────────────────── */}
        <div>
          <SectionHeader title="Console" />
          <div className="flex flex-wrap gap-2">
            {navLinks.map(({ href, label, icon: Icon, badge }) => (
              <Link key={href} href={href} className="inline-flex items-center gap-2 bg-white rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 hover:border-[#1B2850]/30 hover:text-[#1B2850] transition-colors">
                <Icon className="w-4 h-4 text-slate-400" aria-hidden="true" />
                <span>{label}</span>
                {badge != null && badge > 0 && (
                  <span className="ml-0.5 min-w-5 h-5 px-1 bg-red-500 text-white text-[11px] font-bold rounded-full inline-flex items-center justify-center">{badge > 9 ? '9+' : badge}</span>
                )}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
