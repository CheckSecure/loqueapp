import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const ROUTE = readFileSync('app/api/admin/reminders/wednesday-targeted/route.ts', 'utf8')
const CRON = readFileSync('app/api/cron/engagement-reminders/route.ts', 'utf8')
const PURPOSES = readFileSync('lib/reminders/purposes.ts', 'utf8')

describe('targeted Wednesday reminder', () => {
  it('is admin-gated and dry run by default', () => {
    expect(ROUTE).toContain("user.email !== ADMIN_EMAIL")
    expect(ROUTE).toContain("const execute = body.action === 'execute'")
    const guard = ROUTE.indexOf('if (!execute)')
    const send = ROUTE.indexOf('await sendWednesdayIntroReminderEmail(')
    expect(guard).toBeGreaterThan(-1)
    expect(send).toBeGreaterThan(guard)
  })

  it('shares the weekly stage\'s purpose AND cycle key — that is the dedupe', () => {
    // reminder_deliveries' active-claim index is (member_id, purpose, cycle_key). Reusing both
    // means a member the cron already reached is refused the claim, so passing every id in the
    // network still only mails the ones it missed.
    expect(ROUTE).toContain('purpose: REMINDER_PURPOSE')
    expect(ROUTE).toContain('newYorkIsoWeekKey(new Date())')
    expect(CRON).toContain('purpose: REMINDER_PURPOSE')
  })

  it('does NOT reuse the one-per-member-ever catch-up campaign', () => {
    // That route's purpose is keyed to a fixed campaign string, so it cannot see this week's
    // claims — running it today would re-mail everyone already reminded and burn their slot.
    expect(PURPOSES).toContain("CATCHUP_UNANSWERED = 'catchup_unanswered_2026_08_20'")
    expect(ROUTE).not.toContain('CATCHUP_UNANSWERED')
    expect(ROUTE).not.toContain('CATCHUP_CAMPAIGN_KEY')
  })

  it('reports already-reminded members instead of silently skipping them', () => {
    expect(ROUTE).toContain('already_reminded_this_cycle')
    expect(ROUTE).toContain("['claimed', 'accepted', 'delivered', 'deferred']")
  })

  it('applies the same eligibility and target-active gate as the cron', () => {
    expect(ROUTE).toContain('openCardsFor(memberId, openRows, activeTargetIds)')
    expect(ROUTE).toContain('reminderIneligibility(p, openCount)')
  })

  it('fails closed on either read', () => {
    // A partial card read mis-states open counts; a partial profile read marks live targets
    // inactive. Both would mail the wrong people.
    const failures = ROUTE.match(/Read failed; nothing was sent/g) ?? []
    expect(failures).toHaveLength(2)
  })

  it('caps the target list', () => {
    expect(ROUTE).toMatch(/const MAX_TARGETS = \d+/)
  })
})
