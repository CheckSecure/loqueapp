import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import {
  Inbox, Wrench, ArrowLeft, GitBranch, Mail, Activity, Users, Send, ShieldAlert, CircleAlert, ChevronRight,
} from 'lucide-react'
import { loadAdminDashboard } from '@/lib/admin/dashboardData'
import { THRESHOLDS } from '@/lib/admin/dashboardMetrics'

export const metadata = { title: 'Operations | Admin | Andrel' }
// Admin-only + never cached: renders one operator's sensitive operational data.
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * OPERATIONS — the detail page behind the calm admin homepage.
 *
 * Everything here used to be rendered on /dashboard/admin. The homepage now answers only
 * "what needs me?" and "where do I go?", so the full attention list (including the technical
 * items that are NOT member incidents), invitation/delivery diagnostics, matching
 * diagnostics, member engagement, platform health and the honest monitoring gaps all live
 * here instead. No metric is computed differently — this renders the same loader output.
 */

const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1B2850] focus-visible:ring-offset-2'
const dotCls: Record<'high' | 'medium' | 'low', string> = { high: 'bg-red-500', medium: 'bg-amber-500', low: 'bg-sky-400' }
type Tone = 'neutral' | 'red' | 'amber' | 'sky'
const accentCls: Record<Tone, string> = {
  neutral: 'border-slate-200', red: 'border-red-300', amber: 'border-amber-300', sky: 'border-sky-200',
}

/** Compact metric card. `tip` becomes an accessible tooltip (numerator/denominator/timeframe/rules). */
function Stat({ label, value, tip, sub, href, tone = 'neutral' }: {
  label: string; value: string | number; tip: string; sub?: string | null; href?: string; tone?: Tone
}) {
  const inner = (
    <div className={`h-full min-w-0 bg-white rounded-xl border ${accentCls[tone]} p-4`} title={tip} aria-label={`${label}: ${value}. ${tip}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-2xl font-bold text-slate-900 leading-none">{value}</p>
        <span className="text-slate-300" aria-hidden="true">ⓘ</span>
      </div>
      <p className="text-[11px] text-slate-500 mt-1.5 leading-tight break-words">{label}</p>
      {sub != null && <p className="text-[11px] text-slate-400 mt-0.5 leading-tight break-words">{sub}</p>}
      {href && <p className="text-[11px] text-[#1B2850] mt-1 font-medium">View →</p>}
    </div>
  )
  return href ? <Link href={href} className={`block rounded-xl hover:opacity-90 transition-opacity ${FOCUS}`}>{inner}</Link> : inner
}

function SectionHeader({ id, title, note }: { id: string; title: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-2">
      <h2 id={id} className="text-sm font-semibold text-slate-500 uppercase tracking-wide">{title}</h2>
      {note && <span className="text-[11px] text-slate-400 text-right">{note}</span>}
    </div>
  )
}

function Unavailable({ label }: { label: string }) {
  return <div className="bg-white rounded-xl border border-slate-200 p-4"><p className="text-sm text-slate-400">{label}: unavailable</p></div>
}

export default async function OperationsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  const dash = await loadAdminDashboard(createAdminClient(), {
    now: Date.now(),
    adminEmail: user.email, // loader re-checks admin authorization (defense-in-depth)
    env: { deployedSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null },
  })

  const inv = dash.invitations
  const rec = dash.recommendations
  const mem = dash.members
  const p = dash.platform

  return (
    <div className="min-h-screen bg-slate-50 overflow-x-hidden p-5 sm:p-6 lg:px-8">
      <div className="max-w-5xl mx-auto space-y-7">
        <div>
          <Link href="/dashboard/admin" className={`inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-[#1B2850] transition-colors mb-3 rounded ${FOCUS}`}>
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Admin
          </Link>
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#F5F6FB] flex items-center justify-center flex-shrink-0">
              <Wrench className="w-5 h-5 text-[#1B2850]" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Operations</h1>
              <p className="text-sm text-slate-500 mt-1">Full diagnostics, delivery and platform health, and advanced support tools.</p>
            </div>
          </div>
        </div>

        {/* ── Every attention item, including the technical ones the homepage omits ── */}
        <section aria-labelledby="ops-attention">
          <SectionHeader id="ops-attention" title="All attention items" note={`${dash.needsAttention.length} item${dash.needsAttention.length === 1 ? '' : 's'}`} />
          <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
            {dash.needsAttention.length === 0 ? (
              <p className="px-4 py-3 text-sm text-slate-500">No actionable items right now. Monitoring gaps below are informational.</p>
            ) : dash.needsAttention.map((item) => (
              <Link key={item.id} href={item.href} className={`flex items-start gap-3 px-4 py-3 hover:bg-slate-50 transition-colors ${FOCUS}`} title={item.explanation}>
                <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${dotCls[item.severity]}`} aria-hidden="true" />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-slate-800">{item.title}</span>
                    <span className="text-[11px] font-semibold text-slate-500 bg-slate-100 rounded px-1.5 py-0.5">{item.count}</span>
                  </span>
                  <span className="block text-[11px] text-slate-500 mt-0.5 leading-tight break-words">{item.explanation}</span>
                </span>
                <ChevronRight className="w-4 h-4 text-slate-300 flex-shrink-0 mt-1" aria-hidden="true" />
              </Link>
            ))}
          </div>
        </section>

        {/* ── Invitations & activation ─────────────────────────────────────────────── */}
        <section aria-labelledby="ops-invitations">
          <SectionHeader id="ops-invitations" title="Invitations & Activation" note="counts unique people, not attempts" />
          {!inv.ok ? <Unavailable label="Invitation metrics" /> : (
            <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Awaiting review" value={inv.data.awaitingReview} href="/dashboard/admin/waitlist" tip="Waitlist entries with status 'pending' — applicants awaiting an approval decision." />
              <Stat label="Invited (people)" value={inv.data.invited} href="/dashboard/admin/waitlist" tip="Unique invited invitees: waitlist entries with status 'invited' and a non-null invited_at." />
              <Stat label="Delivery pending (people)" value={inv.data.deliveryPending} tone={inv.data.deliveryStuck > 0 ? 'amber' : 'neutral'} href="/dashboard/admin/waitlist" tip={`Unique invitees whose CURRENT delivery state is in-flight (claimed/accepted/deferred). ${inv.data.deliveryStuck} stuck > ${THRESHOLDS.DELIVERY_STUCK_HOURS}h.`} sub={inv.data.deliveryStuck > 0 ? `${inv.data.deliveryStuck} stuck` : null} />
              <Stat label="Delivered (people)" value={inv.data.delivered} tip="Unique invitees whose CURRENT collapsed state is 'delivered' (a later resend can flip an earlier bounce to delivered)." />
              <Stat label="Bounced / blocked / failed (people)" value={inv.data.failed} tone={inv.data.failed > 0 ? 'red' : 'neutral'} href="/dashboard/admin/waitlist" tip="Unique invitees whose CURRENT state is terminal-failure (bounced/blocked/complained/failed) — a later bounce after a delivery counts here." />
              <Stat label="Activated (people)" value={inv.data.activated ?? '—'} tone={inv.data.activationAvailable ? 'neutral' : 'amber'} tip="Unique DELIVERED invitees who have signed in (auth last_sign_in_at not null). Denominator of conversion = unique delivered invitees." sub={!inv.data.activationAvailable ? 'unavailable (Auth listing incomplete)' : inv.data.conversionRate != null ? `${inv.data.conversionRate}% of delivered` : null} />
              <Stat label="Not activated 24h / 3d / 7d" value={inv.data.activationAvailable ? `${inv.data.notActivated24h} / ${inv.data.notActivated3d} / ${inv.data.notActivated7d}` : 'unavailable'} tone={(inv.data.notActivated7d ?? 0) > 0 ? 'amber' : 'neutral'} tip="Unique delivered invitees, delivered ≥24h/3d/7d ago, never signed in (cumulative). Unavailable when the Auth listing is incomplete." />
              <Stat label="Historical (status unknown)" value={inv.data.historicalUnknown} tip="Invited invitees with NO delivery record (pre-tracking sends) — delivery status is genuinely unavailable, not a failure." />
            </div>
            <p className="mt-2 text-[11px] text-slate-400 break-words">
              Attempts (operational, not people): {inv.data.attempts.total} total · {inv.data.attempts.delivered} delivered · {inv.data.attempts.failed} failed
              {Object.entries(inv.data.attempts.byPurpose).length > 0 && <> · {Object.entries(inv.data.attempts.byPurpose).map(([k, v]) => `${v} ${k}`).join(' · ')}</>}
              {inv.data.unattributableAttempts > 0 && <> · {inv.data.unattributableAttempts} unattributable</>}
              {inv.data.manualReview > 0 && <> · <span className="text-amber-600">{inv.data.manualReview} manual-review (email reassigned)</span></>}
            </p>
            </>
          )}
        </section>

        {/* ── Recommendations & matching ───────────────────────────────────────────── */}
        <section aria-labelledby="ops-recommendations">
          <SectionHeader id="ops-recommendations" title="Recommendations & Matching" />
          {!rec.ok ? <Unavailable label="Recommendation metrics" /> : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Eligible without a recommendation" value={rec.data.eligibleWithoutRec} tone={rec.data.eligibleWithoutRec > 0 ? 'amber' : 'neutral'} href="/dashboard/admin/batches" tip="Eligible members (active, complete, non-test/non-admin) with zero active suggestion cards (status suggested/queued)." />
              <Stat label="Reciprocal pairs created" value={rec.data.reciprocalPairsCreated} tip="Total member_pairs rows — canonical two-person auto-introduction pairs created all-time." />
              <Stat label="Active reciprocal suggestions" value={rec.data.activeReciprocalSuggestions} tip="Directional intro_requests cards with a pair_id and status 'suggested' (both sides of a live pair)." />
              <Stat label="One-sided legacy suggestions" value={rec.data.oneSidedLegacySuggestions} tone={rec.data.oneSidedLegacySuggestions > 0 ? 'sky' : 'neutral'} tip="Suggested intro_requests with NO pair_id — legacy batch-model one-directional cards." />
              <Stat label="Members at capacity" value={rec.data.membersAtCapacity} tip="Eligible members holding the maximum 2 VISIBLE cards (status suggested). Reserved 'queued' cards are a separate tier and do not count toward this." />
              <Stat label="Pairs nearing rotation" value={rec.data.nearingRotation} tip={`Active pairs last recommended ${THRESHOLDS.ROTATION_NEARING_DAYS}–${THRESHOLDS.ROTATION_DAYS} days ago — due to rotate soon.`} />
              <Stat label="Pairs overdue for rotation" value={rec.data.staleOverdue} tone={rec.data.staleOverdue > 0 ? 'amber' : 'neutral'} tip={`Active pairs untouched > ${THRESHOLDS.ROTATION_DAYS} days — rotation should have expired them.`} />
              <Stat label="Interest expressed" value={rec.data.interestExpressed} tip="intro_requests in an expressed-interest status (pending/accepted/admin_pending/approved)." />
              <Stat label="Mutual matches" value={rec.data.mutualMatches} href="/dashboard/admin/match-inspector" tip="Unique canonical matched pairs (active, not removed) — reverse rows de-duplicated." />
              <Stat label="Upcoming meetings (from matches)" value={rec.data.upcomingMeetingsFromMatches} tip="Future meetings (scheduled/confirmed/requested) whose two participants form a matched pair." />
              <Stat label="Exposure — median / max inbound" value={`${rec.data.exposure.median} / ${rec.data.exposure.max}`} tone={rec.data.exposure.concentrationAlert ? 'red' : 'neutral'} tip="Median and highest inbound active-suggestion count across eligible members. Alert if the top is ≥4 and ≥3× the median." sub={rec.data.exposure.concentrationAlert ? 'concentration alert' : null} />
            </div>
          )}
        </section>

        {/* ── Members & engagement ─────────────────────────────────────────────────── */}
        <section aria-labelledby="ops-members">
          <SectionHeader id="ops-members" title="Members & Engagement" note="7-day windows" />
          {!mem.ok ? <Unavailable label="Member metrics" /> : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Total members" value={mem.data.totalMembers} href="/dashboard/admin/members" tip="Real people: profiles EXCLUDING test accounts and admin. The superset — Active is a subset." />
              <Stat label="Active members" value={mem.data.activeMembers} href="/dashboard/admin/members" tip="Real members with account_status = 'active'. Subset of Total members (same excluded populations)." />
              <Stat label="Onboarding incomplete" value={mem.data.onboardingIncomplete} tone={mem.data.onboardingIncomplete > 0 ? 'sky' : 'neutral'} tip="Real active members with profile_complete = false — not yet eligible for matching." />
              <Stat label="Active last 7 days" value={mem.data.activeLast7d} tip="Real active members with member_presence last_active_at within 7 days. Numerator ⊆ Active members." sub={mem.data.weeklyActivePct != null ? `${mem.data.weeklyActivePct}% of active members` : null} />
              <Stat label="Active connections (unique pairs)" value={mem.data.activeConnections} tip="Unique canonical matched pairs (active, not removed) — labeled as pairs, not match rows." />
              <Stat label="Messages sent (7d)" value={mem.data.messages7d} tip="Non-system messages created in the last 7 days." />
              <Stat label="Meetings created (7d)" value={mem.data.meetingsCreated7d} tip="meetings rows created in the last 7 days (all statuses)." />
              <Stat label="Upcoming meetings" value={mem.data.upcomingMeetings} tip="Meetings with scheduled_at in the future and status requested/scheduled/confirmed." />
            </div>
          )}
        </section>

        {/* ── Platform health ──────────────────────────────────────────────────────── */}
        <section aria-labelledby="ops-platform">
          <SectionHeader id="ops-platform" title="Platform Health" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {/* Migrations */}
            <div className="min-w-0 bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><GitBranch className="w-4 h-4 text-slate-400" aria-hidden="true" /><p className="text-xs font-semibold text-slate-600">Schema migrations</p></div>
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
            <div className="min-w-0 bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><Mail className="w-4 h-4 text-slate-400" aria-hidden="true" /><p className="text-xs font-semibold text-slate-600">Invitation webhook (7d)</p></div>
              {!p.webhook.ok ? <p className="text-sm text-slate-400">Unavailable</p> : (
                <p className={`text-sm font-medium ${p.webhook.data.errorEvents > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                  {p.webhook.data.totalEvents} events · {p.webhook.data.errorEvents} errors
                </p>
              )}
              <p className="text-[11px] text-slate-400 mt-1">Webhook events are provider callbacks, not affected members.</p>
            </div>
            {/* Deployed SHA */}
            <div className="min-w-0 bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><Activity className="w-4 h-4 text-slate-400" aria-hidden="true" /><p className="text-xs font-semibold text-slate-600">Deployed commit</p></div>
              <p className="text-sm font-mono text-slate-700 truncate">{p.deployedSha ? p.deployedSha.slice(0, 7) : 'Unavailable (local)'}</p>
            </div>
            {/* Auth listing completeness — activation figures depend on a COMPLETE Auth scan */}
            <div className="min-w-0 bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><Users className="w-4 h-4 text-slate-400" aria-hidden="true" /><p className="text-xs font-semibold text-slate-600">Auth activation source</p></div>
              <p className={`text-sm font-medium ${dash.activation.complete ? 'text-emerald-600' : 'text-amber-600'}`}>
                {dash.activation.complete ? `Complete · ${dash.activation.pages} page${dash.activation.pages === 1 ? '' : 's'}` : 'Incomplete — activation figures unavailable'}
              </p>
            </div>
            {/* Cron / Auth / Supabase — no supported live source → honest "Not connected" + link */}
            <div className="min-w-0 bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><Send className="w-4 h-4 text-slate-400" aria-hidden="true" /><p className="text-xs font-semibold text-slate-600">Weekly cron</p></div>
              <p className="text-sm text-slate-400">Not connected</p>
              <a href="https://vercel.com/dashboard" className={`text-[11px] text-[#1B2850] font-medium rounded ${FOCUS}`}>Vercel cron logs →</a>
            </div>
            <div className="min-w-0 bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><ShieldAlert className="w-4 h-4 text-slate-400" aria-hidden="true" /><p className="text-xs font-semibold text-slate-600">Auth / service 5xx</p></div>
              <p className="text-sm text-slate-400">Not connected</p>
              <a href="https://vercel.com/dashboard" className={`text-[11px] text-[#1B2850] font-medium rounded ${FOCUS}`}>Runtime logs →</a>
            </div>
            <div className="min-w-0 bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 mb-1.5"><Activity className="w-4 h-4 text-slate-400" aria-hidden="true" /><p className="text-xs font-semibold text-slate-600">Supabase resources</p></div>
              <p className="text-sm text-slate-400">Not connected</p>
              <a href="https://supabase.com/dashboard" className={`text-[11px] text-[#1B2850] font-medium rounded ${FOCUS}`}>Supabase dashboard →</a>
            </div>
          </div>

          {/* Monitoring gaps — honestly surfaced, never a fake-green status. */}
          <div className="mt-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide mb-1.5">Monitoring not connected</p>
            <ul className="space-y-1">
              {dash.monitoringGaps.map((g) => (
                <li key={g.id} className="text-[11px] text-slate-500 flex items-start gap-1.5">
                  <CircleAlert className="w-3.5 h-3.5 text-slate-400 flex-shrink-0 mt-px" aria-hidden="true" />
                  <span className="break-words"><span className="font-medium text-slate-600">{g.label}:</span> {g.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Support tools ────────────────────────────────────────────────────────── */}
        <section aria-labelledby="ops-tools">
          <SectionHeader id="ops-tools" title="Support tools" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            <Link
              href="/dashboard/admin/intros"
              className={`min-w-0 bg-white rounded-xl border border-slate-200 p-5 hover:border-[#1B2850]/30 hover:shadow-md transition-all group ${FOCUS}`}
            >
              <div className="w-11 h-11 rounded-lg bg-[#F5F6FB] flex items-center justify-center group-hover:bg-[#1B2850] transition-colors mb-3">
                <Inbox className="w-5 h-5 text-[#1B2850] group-hover:text-white transition-colors" aria-hidden="true" />
              </div>
              <h3 className="text-base font-bold text-slate-900 mb-1">Intro Requests</h3>
              <p className="text-sm text-slate-500">View and manage introduction requests and edge cases.</p>
            </Link>
          </div>
        </section>
      </div>
    </div>
  )
}
