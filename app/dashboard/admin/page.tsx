import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import {
  Users, GitBranch, UserPlus, TrendingUp, Search, Wrench, AlertCircle, Sparkles,
  Building2, Network, Send, ArrowRight, CheckCircle2,
} from 'lucide-react'
import { loadAdminDashboard } from '@/lib/admin/dashboardData'
import { triageAttention, attentionActionLabel, MAX_HOME_ATTENTION } from '@/lib/admin/dashboardMetrics'

export const metadata = { title: 'Admin | Andrel' }
// Admin-only + never cached: this page renders one operator's sensitive operational data.
export const dynamic = 'force-dynamic'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * OPERATIONS CONSOLE, not a monitoring report.
 *
 * This page answers two questions and nothing else: "what needs me?" and "where do I go?".
 * Every detailed diagnostic that used to live here — invitation attempt counts, the
 * recommendation/matching grid, member engagement, schema-migration status, the deployed
 * commit, webhook event totals, Auth-listing completeness and the disconnected monitoring
 * sources — still exists, in full, at /dashboard/admin/operations. Nothing was deleted, and
 * no metric is calculated differently; only where it is presented changed.
 */

// Shared focus treatment: every interactive element on this page is a link, and each one
// must show a visible ring under keyboard navigation.
const FOCUS = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1B2850] focus-visible:ring-offset-2'

const severityDot: Record<'high' | 'medium' | 'low', string> = {
  high: 'bg-red-500', medium: 'bg-amber-500', low: 'bg-sky-400',
}

/** Small count pill. Rendered only for a real, non-zero count so a badge is never decorative. */
function Badge({ count }: { count: number }) {
  if (!count || count <= 0) return null
  return (
    <span
      className="ml-auto min-w-[1.25rem] h-5 px-1.5 bg-[#1B2850] text-white text-[11px] font-semibold rounded-full inline-flex items-center justify-center flex-shrink-0"
      aria-label={`${count} waiting`}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

function SectionHeading({ id, title }: { id: string; title: string }) {
  return <h2 id={id} className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-3">{title}</h2>
}

export default async function AdminDashboard() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) redirect('/dashboard')

  const adminClient = createAdminClient()
  const now = Date.now()

  // Single consolidated load — unchanged. The loader still computes every section; this page
  // simply renders the short subset and links to Operations for the rest.
  const dash = await loadAdminDashboard(adminClient, {
    now,
    adminEmail: user.email, // loader re-checks admin authorization (defense-in-depth)
    env: { deployedSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null },
  })

  const { waitlistPending, concierge: pendingConciergeCount, issues: newIssueCount } = dash.operational
  const triage = triageAttention(dash.needsAttention)
  const activeMembers = dash.members.ok ? dash.members.data.activeMembers : null
  const missingIntros = dash.recommendations.ok ? dash.recommendations.data.eligibleWithoutRec : null

  const quickActions = [
    { href: '/dashboard/admin/batches', label: 'Review batches', icon: GitBranch, badge: 0 },
    { href: '/dashboard/admin/bulk-invite', label: 'Invite people', icon: Send, badge: 0 },
    { href: '/dashboard/admin/members', label: 'Manage members', icon: Users, badge: 0 },
    { href: '/dashboard/admin/waitlist', label: 'Review waitlist', icon: UserPlus, badge: waitlistPending },
    { href: '/dashboard/admin/concierge', label: 'Concierge', icon: Sparkles, badge: pendingConciergeCount },
    { href: '/dashboard/admin/issues', label: 'Issue reports', icon: AlertCircle, badge: newIssueCount },
  ]

  const glance: Array<{ label: string; value: number | null; href: string }> = [
    { label: 'Active members', value: activeMembers, href: '/dashboard/admin/members' },
    { label: 'Pending waitlist reviews', value: waitlistPending, href: '/dashboard/admin/waitlist' },
    { label: 'Members missing introductions', value: missingIntros, href: '/dashboard/admin/batches' },
    { label: 'Unresolved issue reports', value: newIssueCount, href: '/dashboard/admin/issues' },
  ]

  const console_: Array<{ group: string; items: Array<{ href: string; label: string; icon: any; desc: string }> }> = [
    {
      group: 'People',
      items: [
        { href: '/dashboard/admin/members', label: 'Members', icon: Users, desc: 'Everyone who has joined.' },
        { href: '/dashboard/admin/waitlist', label: 'Waitlist', icon: UserPlus, desc: 'Approve applicants and invite them.' },
        { href: '/dashboard/admin/companies', label: 'Companies', icon: Building2, desc: 'Company records used for matching.' },
      ],
    },
    {
      group: 'Introductions',
      items: [
        { href: '/dashboard/admin/batches', label: 'Batches', icon: GitBranch, desc: 'Approve suggested introductions.' },
        { href: '/dashboard/admin/concierge', label: 'Concierge', icon: Sparkles, desc: 'Introductions members asked for.' },
        { href: '/dashboard/admin/match-inspector', label: 'Match Inspector', icon: Search, desc: 'Look up any two members.' },
      ],
    },
    {
      group: 'Growth',
      items: [
        { href: '/dashboard/admin/metrics', label: 'Launch Metrics', icon: TrendingUp, desc: 'Sign-ups and introduction outcomes.' },
        { href: '/dashboard/admin/referral-campaign', label: 'Referral Campaign', icon: Network, desc: 'Referral invitations and results.' },
      ],
    },
    {
      group: 'System',
      items: [
        { href: '/dashboard/admin/operations', label: 'Operations', icon: Wrench, desc: 'Diagnostics and support tools.' },
        { href: '/dashboard/admin/issues', label: 'Issue Reports', icon: AlertCircle, desc: 'Problems members reported.' },
      ],
    },
  ]

  return (
    <div className="min-h-screen bg-slate-50 overflow-x-hidden p-5 sm:p-6 lg:px-8">
      <div className="max-w-6xl mx-auto space-y-7">
        {/* ── Header ─────────────────────────────────────────────────────────────── */}
        <header>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Admin</h1>
          <p className="text-sm text-slate-500 mt-1">Manage members, introductions, invitations, and platform operations.</p>
        </header>

        {/* ── 1. Needs Attention ─────────────────────────────────────────────────── */}
        <section aria-labelledby="needs-attention-heading">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 id="needs-attention-heading" className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Needs Attention</h2>
            {triage.hasMore && (
              <Link href="/dashboard/admin/operations" className={`text-sm font-medium text-[#1B2850] hover:underline rounded ${FOCUS}`}>
                View all in Operations
              </Link>
            )}
          </div>

          {triage.top.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 px-4 py-4 flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" aria-hidden="true" />
              <p className="text-sm text-slate-700">
                Nothing needs you right now.
                <span className="text-slate-500"> Everything with a person waiting on it is clear.</span>
              </p>
            </div>
          ) : (
            <ul className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
              {triage.top.slice(0, MAX_HOME_ATTENTION).map((item) => (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    className={`flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-4 py-3 min-h-[3.5rem] hover:bg-slate-50 transition-colors ${FOCUS}`}
                  >
                    <span className="flex items-start gap-3 flex-1 min-w-0">
                      <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${severityDot[item.severity]}`} aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-slate-900">
                          {item.title} <span className="text-slate-500 font-normal">· {item.count}</span>
                        </span>
                        <span className="block text-xs text-slate-500 mt-0.5 leading-snug break-words">{item.explanation}</span>
                      </span>
                    </span>
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-[#1B2850] flex-shrink-0 pl-5 sm:pl-0">
                      {attentionActionLabel(item.href)}
                      <ArrowRight className="w-4 h-4" aria-hidden="true" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 2. Quick Actions ───────────────────────────────────────────────────── */}
        <section aria-labelledby="quick-actions-heading">
          <SectionHeading id="quick-actions-heading" title="Quick Actions" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {quickActions.map(({ href, label, icon: Icon, badge }) => (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-3 min-w-0 min-h-[3.5rem] bg-white rounded-xl border border-slate-200 px-4 py-4 hover:border-[#1B2850]/40 hover:shadow-sm transition-all ${FOCUS}`}
              >
                <Icon className="w-5 h-5 text-[#1B2850] flex-shrink-0" aria-hidden="true" />
                <span className="text-sm font-semibold text-slate-900 truncate">{label}</span>
                <Badge count={badge} />
              </Link>
            ))}
          </div>
        </section>

        {/* ── 3. At a Glance ─────────────────────────────────────────────────────── */}
        <section aria-labelledby="at-a-glance-heading">
          <SectionHeading id="at-a-glance-heading" title="At a Glance" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {glance.map(({ label, value, href }) => (
              <Link
                key={label}
                href={href}
                className={`block min-w-0 bg-white rounded-xl border border-slate-200 px-4 py-3.5 hover:border-[#1B2850]/40 transition-colors ${FOCUS}`}
              >
                <p className="text-2xl font-bold text-slate-900 leading-none">{value ?? '—'}</p>
                <p className="text-xs text-slate-500 mt-1.5 leading-snug break-words">{label}</p>
              </Link>
            ))}
          </div>
        </section>

        {/* ── 4. Console ─────────────────────────────────────────────────────────── */}
        <section aria-labelledby="console-heading">
          <SectionHeading id="console-heading" title="Console" />
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-4 gap-y-5">
            {console_.map(({ group, items }) => (
              <div key={group} className="min-w-0">
                <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">{group}</h3>
                <div className="space-y-2">
                  {items.map(({ href, label, icon: Icon, desc }) => (
                    <Link
                      key={href}
                      href={href}
                      className={`flex items-start gap-3 min-w-0 min-h-[3.5rem] bg-white rounded-xl border border-slate-200 px-3.5 py-3 hover:border-[#1B2850]/40 hover:shadow-sm transition-all ${FOCUS}`}
                    >
                      <span className="w-8 h-8 rounded-lg bg-[#F5F6FB] flex items-center justify-center flex-shrink-0">
                        <Icon className="w-4 h-4 text-[#1B2850]" aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-slate-900">{label}</span>
                        <span className="block text-xs text-slate-500 mt-0.5 leading-snug break-words">{desc}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
