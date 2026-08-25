import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { computeNeedsAttention, isTechnicalAttention } from '@/lib/admin/dashboardMetrics'

/**
 * The admin homepage is a DOOR, not a dashboard.
 *
 * It raises no alerts of its own. It offers Quick Actions, four At-a-Glance numbers, and a
 * Console of destinations — in that order. Every alert and every diagnostic, member-impacting
 * and technical alike, lives at /dashboard/admin/operations, one click away via
 * Console → System → Operations. These tests lock BOTH halves: the homepage stays bare and
 * the detail is not silently deleted.
 *
 * The pages are JSX server components this vitest setup cannot render (tsconfig jsx=preserve),
 * so — consistent with admin-nav-referral-campaign.test.ts and admin-badge-count.test.ts —
 * the page assertions are made on source. computeNeedsAttention is pure and IS executed.
 */
const HOME = readFileSync('app/dashboard/admin/page.tsx', 'utf8')
const OPS = readFileSync('app/dashboard/admin/operations/page.tsx', 'utf8')

// ── 1. Header ────────────────────────────────────────────────────────────────────────
describe('header', () => {
  it('is titled "Admin" with the operations subtitle', () => {
    expect(HOME).toMatch(/>Admin<\/h1>/)
    expect(HOME).toContain('Manage members, introductions, invitations, and platform operations.')
  })

  it('drops "Launch operations console" and the old "Admin Dashboard" title', () => {
    expect(HOME).not.toContain('Launch operations console')
    expect(HOME).not.toMatch(/>Admin Dashboard</)
  })
})

// ── 2. Needs Attention is GONE from the homepage ────────────────────────────────────
describe('Needs Attention is absent', () => {
  it('renders no attention section, heading, or row', () => {
    expect(HOME).not.toContain('Needs Attention')
    expect(HOME).not.toContain('needs-attention')
    expect(HOME).not.toContain('View all in Operations')
    expect(HOME).not.toContain('Nothing needs you right now')
  })

  it('reads no attention data and imports no attention helper', () => {
    for (const token of ['needsAttention', 'triageAttention', 'attentionActionLabel', 'MAX_HOME_ATTENTION', 'severityDot']) {
      expect(HOME, `${token} still referenced`).not.toContain(token)
    }
    // the whole dashboardMetrics import existed only for that section
    expect(HOME).not.toContain("from '@/lib/admin/dashboardMetrics'")
  })

  it('drops the icons and severity styling only that section used', () => {
    for (const token of ['ArrowRight', 'CheckCircle2', 'bg-red-500', 'bg-amber-500', 'bg-sky-400']) {
      expect(HOME, `${token} is now unused`).not.toContain(token)
    }
  })

  it('still loads the dashboard once — the badges and glance numbers need it', () => {
    expect((HOME.match(/loadAdminDashboard\(/g) || []).length).toBe(1)
  })
})

describe('section order', () => {
  const order = ['quick-actions-heading', 'at-a-glance-heading', 'console-heading']

  it('is Quick Actions, then At a Glance, then Console — and nothing before them', () => {
    const positions = order.map((id) => HOME.indexOf(`<SectionHeading id="${id}"`))
    expect(positions.every((n) => n > -1)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('Quick Actions is the FIRST section after the header', () => {
    const firstSection = HOME.indexOf('<section')
    const header = HOME.indexOf('<header>')
    expect(header).toBeGreaterThan(-1)
    expect(header).toBeLessThan(firstSection)
    expect(HOME.slice(firstSection, firstSection + 200)).toContain('quick-actions-heading')
  })

  it('renders exactly three sections', () => {
    expect((HOME.match(/<section aria-labelledby=/g) || []).length).toBe(3)
    expect((HOME.match(/<SectionHeading /g) || []).length).toBe(3)
  })
})

// ── 3. Quick Actions ─────────────────────────────────────────────────────────────────
describe('Quick Actions', () => {
  const REQUIRED: Array<[string, string]> = [
    ['Review batches', '/dashboard/admin/batches'],
    ['Invite people', '/dashboard/admin/bulk-invite'],
    ['Manage members', '/dashboard/admin/members'],
    ['Review waitlist', '/dashboard/admin/waitlist'],
    ['Concierge', '/dashboard/admin/concierge'],
    ['Issue reports', '/dashboard/admin/issues'],
  ]

  it('renders all six, each paired with its destination', () => {
    const block = HOME.slice(HOME.indexOf('const quickActions'), HOME.indexOf(']', HOME.indexOf('const quickActions')))
    for (const [label, href] of REQUIRED) {
      expect(block).toContain(`'${href}'`)
      expect(block).toContain(`'${label}'`)
    }
    expect((block.match(/href:/g) || []).length).toBe(REQUIRED.length)
  })

  it('badges come from real counts and are suppressed at zero', () => {
    const block = HOME.slice(HOME.indexOf('const quickActions'), HOME.indexOf(']', HOME.indexOf('const quickActions')))
    expect(block).toContain('badge: waitlistPending')
    expect(block).toContain('badge: pendingConciergeCount')
    expect(block).toContain('badge: newIssueCount')
    // no invented number for a destination with nothing pending
    expect((block.match(/badge: 0/g) || []).length).toBe(3)
    expect(HOME).toMatch(/if \(!count \|\| count <= 0\) return null/)
  })

  it('executes no mutation from the homepage — every control is a link', () => {
    expect(HOME).not.toMatch(/<(button|form)\b/)
    expect(HOME).not.toMatch(/onClick|onSubmit|method="post"/i)
    expect(HOME).not.toMatch(/fetch\(|\.rpc\(|\.insert\(|\.update\(|\.delete\(/)
  })
})

// ── 4. At a Glance ───────────────────────────────────────────────────────────────────
describe('At a Glance', () => {
  it('is exactly four values, each linking somewhere the records can be reviewed', () => {
    const block = HOME.slice(HOME.indexOf('const glance'), HOME.indexOf(']', HOME.indexOf('const glance')))
    expect((block.match(/label: '/g) || []).length).toBe(4)
    for (const label of ['Active members', 'Pending waitlist reviews', 'Members missing introductions', 'Unresolved issue reports']) {
      expect(block).toContain(label)
    }
    for (const href of ['/dashboard/admin/members', '/dashboard/admin/waitlist', '/dashboard/admin/batches', '/dashboard/admin/issues']) {
      expect(block).toContain(href)
    }
  })

  it('reads the same loader values as before — no metric is recomputed on the page', () => {
    expect(HOME).toContain('dash.members.data.activeMembers')
    expect(HOME).toContain('dash.recommendations.data.eligibleWithoutRec')
    // an unavailable section degrades to an em dash, never to a fake zero
    expect(HOME).toContain("{value ?? '—'}")
  })
})

// ── 5. Console groups ────────────────────────────────────────────────────────────────
describe('Console navigation', () => {
  const GROUPS: Record<string, Array<[string, string]>> = {
    People: [['Members', '/dashboard/admin/members'], ['Waitlist', '/dashboard/admin/waitlist'], ['Companies', '/dashboard/admin/companies']],
    Introductions: [['Batches', '/dashboard/admin/batches'], ['Concierge', '/dashboard/admin/concierge'], ['Match Inspector', '/dashboard/admin/match-inspector']],
    Growth: [['Launch Metrics', '/dashboard/admin/metrics'], ['Referral Campaign', '/dashboard/admin/referral-campaign']],
    System: [['Operations', '/dashboard/admin/operations'], ['Issue Reports', '/dashboard/admin/issues']],
  }
  const consoleBlock = HOME.slice(HOME.indexOf('const console_'), HOME.indexOf('return (', HOME.indexOf('const console_')))

  it('declares the four required groups, in order', () => {
    const order = Object.keys(GROUPS)
    const positions = order.map((g) => consoleBlock.indexOf(`group: '${g}'`))
    expect(positions.every((n) => n > -1)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('places every destination in its required group, with an icon and a description', () => {
    for (const [group, entries] of Object.entries(GROUPS)) {
      const start = consoleBlock.indexOf(`group: '${group}'`)
      const next = Object.keys(GROUPS).map((g) => consoleBlock.indexOf(`group: '${g}'`)).filter((n) => n > start).sort((a, b) => a - b)[0] ?? consoleBlock.length
      const slice = consoleBlock.slice(start, next)
      for (const [label, href] of entries) {
        expect(slice).toContain(`label: '${label}'`)
        expect(slice).toContain(`'${href}'`)
      }
      expect((slice.match(/icon:/g) || []).length).toBe(entries.length)
      expect((slice.match(/desc:/g) || []).length).toBe(entries.length)
    }
  })

  it('shows no underlying diagnostic data on a console card', () => {
    expect(consoleBlock).not.toMatch(/dash\.|inv\.data|rec\.data|mem\.data/)
  })
})

// ── 6. Every destination link resolves to a real route ───────────────────────────────
describe('destination links are valid routes', () => {
  it('every /dashboard/admin/* href on the homepage has a page file', () => {
    const hrefs = Array.from(new Set(HOME.match(/\/dashboard\/admin\/[a-z-]+/g) || []))
    expect(hrefs.length).toBeGreaterThanOrEqual(10)
    for (const href of hrefs) {
      const segment = href.replace('/dashboard/admin/', '')
      expect(existsSync(`app/dashboard/admin/${segment}/page.tsx`), `${href} has no page.tsx`).toBe(true)
    }
  })

  it('links only to admin routes — no external dashboards from the homepage', () => {
    expect(HOME).not.toContain('vercel.com')
    expect(HOME).not.toContain('supabase.com')
    expect(HOME).not.toMatch(/href="https?:/)
  })
})

// ── 7. The dense sections are GONE from the homepage ─────────────────────────────────
describe('removed homepage sections', () => {
  const GONE = [
    'Needs Attention', 'Invitations & Activation', 'Recommendations & Matching', 'Members & Engagement',
    'Platform Health', 'Monitoring not connected', 'Deployed commit', 'Schema migrations',
    'Auth activation source', 'Invitation webhook', 'Attempts (operational, not people)',
    'Not activated 24h', 'Exposure — median / max inbound',
  ]

  it('renders none of the old dense grids or telemetry panels', () => {
    for (const label of GONE) expect(HOME, `"${label}" still on the homepage`).not.toContain(label)
  })

  it('reads none of the detail sections off the loader', () => {
    for (const expr of ['dash.platform', 'dash.invitations', 'dash.monitoringGaps', 'dash.activation', 'deployedSha ?']) {
      expect(HOME).not.toContain(expr)
    }
    expect(HOME).not.toContain('VERCEL_GIT_COMMIT_SHA ?? null,\n    },\n  })\n  const p =')
  })

  it('is materially shorter than the report it replaced', () => {
    expect(HOME.split('\n').length).toBeLessThan(200) // the original report page was 272 lines
  })
})

// ── 8. Nothing was silently deleted — Operations holds it all ────────────────────────
describe('Operations is the destination for everything removed', () => {
  it('renders each moved section', () => {
    for (const label of [
      'All attention items', 'Invitations & Activation', 'Recommendations & Matching',
      'Members & Engagement', 'Platform Health', 'Monitoring not connected',
      'Deployed commit', 'Schema migrations', 'Auth activation source', 'Invitation webhook (7d)',
      'Attempts (operational, not people)',
    ]) {
      expect(OPS, `"${label}" missing from Operations`).toContain(label)
    }
  })

  it('shows the COMPLETE attention list — unfiltered, uncapped, technical included', () => {
    expect(OPS).toContain('dash.needsAttention.map')
    expect(OPS).not.toContain('triageAttention')   // no triage: Operations shows everything
    // never truncated: the assertion is scoped to the attention block, since the deployed-SHA
    // card legitimately slices a commit hash further down the page
    const block = OPS.slice(OPS.indexOf('dash.needsAttention.length'), OPS.indexOf('Invitations & Activation'))
    expect(block).not.toContain('.slice(')
    expect(OPS).toContain('{dash.needsAttention.length}') // the count it renders is the full count
  })

  it('every item computeNeedsAttention can emit is reachable there, member-impacting or not', () => {
    const produced = computeNeedsAttention({
      invitations: { failed: 1, deliveryStuck: 1, notActivated7d: 1, notActivated3d: 1 } as any,
      recommendations: { eligibleWithoutRec: 1, staleOverdue: 1, exposure: { median: 1, max: 9, concentrationAlert: true } } as any,
      pendingMigrations: [{ migration: '084_x', message: 'm', impact: 'i' }],
      webhookErrors: 2,
      operational: { waitlistPending: 1, concierge: 1, issues: 1, adminIntros: 1, batchNeedsReview: true },
    })
    expect(produced.length).toBeGreaterThanOrEqual(12)
    // the technical ones — the reason the homepage never carried this list — are all present
    expect(produced.filter((i) => isTechnicalAttention(i.id)).length).toBeGreaterThanOrEqual(4)
    // and every single href is a real admin route the operator can actually open
    for (const i of produced) {
      const seg = i.href.replace('/dashboard/admin/', '')
      expect(existsSync(`app/dashboard/admin/${seg}/page.tsx`), `${i.id} -> ${i.href}`).toBe(true)
    }
  })

  it('is one click from the homepage, so nothing is stranded', () => {
    expect(HOME).toContain("href: '/dashboard/admin/operations'")
    expect(HOME).toMatch(/group: 'System'[\s\S]{0,300}\/dashboard\/admin\/operations/)
  })

  it('keeps the pre-existing Intro Requests tool and the external log links', () => {
    expect(OPS).toContain('/dashboard/admin/intros')
    expect(OPS).toContain('Intro Requests')
    expect(OPS).toContain('https://vercel.com/dashboard')
    expect(OPS).toContain('https://supabase.com/dashboard')
  })

  it('states plainly that webhook events are not affected members', () => {
    expect(OPS).toContain('Webhook events are provider callbacks, not affected members.')
  })

  it('never tells the operator to go to Operations while already on Operations', () => {
    const src = readFileSync('lib/admin/dashboardMetrics.ts', 'utf8')
    expect(src).not.toContain('inspect delivery/webhook state in Operations')
    expect(src).toContain('Review delivery and webhook details on this page.')
  })

  it('reuses the shared thresholds instead of re-deriving any number', () => {
    expect(OPS).toContain("from '@/lib/admin/dashboardMetrics'")
    expect(OPS).toContain('THRESHOLDS.DELIVERY_STUCK_HOURS')
    expect(OPS).toContain('THRESHOLDS.ROTATION_DAYS')
  })
})

// ── 9. Authorization and caching are unchanged ───────────────────────────────────────
describe('admin authorization is unchanged', () => {
  it('both pages gate on the admin email and redirect otherwise', () => {
    for (const src of [HOME, OPS]) {
      expect(src).toContain("const ADMIN_EMAIL = 'bizdev91@gmail.com'")
      expect(src).toContain('user.email !== ADMIN_EMAIL')
      expect(src).toContain("redirect('/dashboard')")
    }
  })

  it('both re-authorize at the loader boundary (defense in depth)', () => {
    for (const src of [HOME, OPS]) expect(src).toContain('adminEmail: user.email')
  })

  it('both stay server components that are never publicly cached', () => {
    for (const src of [HOME, OPS]) {
      expect(src).not.toMatch(/^['"]use client['"]/m)
      expect(src).toContain("export const dynamic = 'force-dynamic'")
    }
  })

  it('the homepage still invokes the loader exactly once', () => {
    expect((HOME.match(/loadAdminDashboard\(/g) || []).length).toBe(1)
  })

  it('renders no per-person PII', () => {
    for (const src of [HOME, OPS]) {
      expect(src).not.toMatch(/\.recipient_email|\.emails\b|\.authIds\b|\.byEmail|provider_message_id|svix_id/i)
    }
  })
})

// ── 10. Layout: single column on mobile, no horizontal overflow ──────────────────────
describe('responsive layout', () => {
  it('the homepage clips horizontal overflow at the root', () => {
    expect(HOME).toMatch(/min-h-screen bg-slate-50 overflow-x-hidden/)
    expect(OPS).toMatch(/min-h-screen bg-slate-50 overflow-x-hidden/)
  })

  it('every grid is single-column on a phone and widens only at a breakpoint', () => {
    const grids = HOME.match(/grid grid-cols-[^"'`]*/g) || []
    expect(grids.length).toBe(3) // quick actions, at-a-glance, console — no others
    for (const cls of grids) {
      expect(cls, cls).toMatch(/^grid grid-cols-1\b/)
      expect(cls, cls).toMatch(/\b(sm|md|lg|xl):grid-cols-\d/) // widens, never stuck at one column
    }
  })

  it('lays the four console groups out as columns so they share one band on desktop', () => {
    expect(HOME).toMatch(/grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4[^"'`]*/)
  })

  it('flex/grid children can actually shrink, so long text wraps instead of scrolling', () => {
    expect((HOME.match(/min-w-0/g) || []).length).toBeGreaterThanOrEqual(4)
    expect((HOME.match(/break-words/g) || []).length).toBeGreaterThanOrEqual(2)
    expect(HOME).not.toMatch(/\boverflow-x-auto\b|\bwhitespace-nowrap\b/)
    // no fixed width wide enough to force a scrollbar on the narrowest phone (320px)
    for (const m of HOME.match(/\b(?:min-)?w-\[(\d+)px\]/g) || []) {
      expect(Number(m.match(/(\d+)px/)![1]), m).toBeLessThan(320)
    }
  })

  it('keeps accessible labels, visible focus, and adequate tap targets', () => {
    expect(HOME).toContain('focus-visible:ring-2')
    expect((HOME.match(/aria-labelledby=/g) || []).length).toBe(3) // one per section
    expect((HOME.match(/aria-hidden="true"/g) || []).length).toBeGreaterThanOrEqual(2) // decorative icons
    expect(HOME).toContain('aria-label={`${count} waiting`}')
    expect((HOME.match(/min-h-\[3\.5rem\]/g) || []).length).toBeGreaterThanOrEqual(2) // quick actions + console cards
  })

  it('uses no nested accordion or dense table on the homepage', () => {
    expect(HOME).not.toMatch(/<details|<summary|<table|<thead|<tbody/)
    expect(HOME).not.toMatch(/text-\[10px\]|text-\[9px\]/)
  })
})
