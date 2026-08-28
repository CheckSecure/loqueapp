import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { EXPIRY_AGE_DAYS } from '@/lib/introductions/expiry'

const WORKER   = readFileSync('lib/introductions/expiryWorker.ts', 'utf8')
const NOTIF    = readFileSync('lib/notifications/index.ts', 'utf8')
const BACKFILL = readFileSync('supabase/repairs/backfill_orphaned_interest.sql', 'utf8')
/** Executable source only — comments legitimately name what the code must not do. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ' ')

/**
 * THE DEFECT. Only expire_intro_pair can move an 'approved' row and it requires a pair_id; every
 * other expiry path filters 'suggested' or 'pending'. A non-pair row the expresser approved was
 * therefore unreachable — it sat 'approved' forever while the UI said "Awaiting their response".
 * Production held 34 such rows across 21 members, the oldest six weeks old.
 */
describe('orphaned one-sided interest is closable', () => {
  it('the stage targets exactly the unreachable rows', () => {
    const c = code(WORKER)
    expect(c).toMatch(/\.eq\('status', 'approved'\)/)
    expect(c).toMatch(/\.is\('pair_id', null\)/)
    expect(c).toMatch(/\.eq\('is_admin_initiated', false\)/)
  })

  it('measures the window from updated_at, not created_at', () => {
    // updated_at is when the expresser acted, so it is when the counterpart's window began.
    // created_at would close a card approved yesterday because it was recommended weeks ago.
    expect(code(WORKER)).toMatch(/\.lt\('updated_at', cutoff\)/)
  })

  it('reads the SAME window constant as the pair path — the two cannot drift', () => {
    expect(EXPIRY_AGE_DAYS).toBe(14)
    expect(code(WORKER)).toMatch(/EXPIRY_AGE_DAYS \* 24 \* 60 \* 60 \* 1000/)
    expect(code(WORKER)).not.toMatch(/interval '14 days'|14 \* 24 \* 60/)  // no second copy
  })

  // ── Guards, mirroring expire_intro_pair (066). ──
  it('never closes a matched pair', () => {
    expect(code(WORKER)).toMatch(/orphan_skipped_matched/)
  })

  it('never closes a MUTUAL pair — finalization owns it, incl. the credit-blocked case', () => {
    const c = code(WORKER)
    expect(c).toMatch(/orphan_skipped_mutual/)
    expect(c).toMatch(/\['approved', 'accepted', 'pending'\]\.includes\(counterpart\.status\)/)
  })

  it('never closes one whose counterpart can still answer', () => {
    expect(code(WORKER)).toMatch(/orphan_skipped_counterpart_live/)
  })

  // ── The status that was missed the first time. ──
  it("HOLDS a 'queued' counterpart — never shown is not the same as never answered", () => {
    const c = code(WORKER)
    expect(c).toMatch(/counterpart\.status === 'queued'/)
    expect(c).toMatch(/orphan_held_counterpart_queued/)
    // The queued branch must come BEFORE the close, or it is unreachable. Scoped to the ORPHAN
    // stage: the legacy branch earlier in the file also writes status:'expired', and an unscoped
    // indexOf would compare against that instead.
    const stage = c.slice(c.indexOf('orphan_read_failed'))
    expect(stage.indexOf("counterpart.status === 'queued'"))
      .toBeLessThan(stage.indexOf("status: 'expired'"))
  })

  it("the backfill HOLDS 'queued' in section A and excludes it in section B", () => {
    expect(BACKFILL).toMatch(/HOLD — counterpart never shown \(queued\)/)
    // Section B's guard must list 'queued' too, or the SQL would close what the worker holds.
    const sqlOnly = BACKFILL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(sqlOnly).toMatch(/'approved','accepted','pending','suggested','queued'/)
  })

  it('the worker and the backfill agree on what is closable', () => {
    // Both must hold: matched, mutual, still-answerable, never-shown. A divergence means the cron
    // would close rows the operator was told would be held.
    const c = code(WORKER)
    for (const guard of ['orphan_skipped_matched', 'orphan_skipped_mutual',
                         'orphan_skipped_counterpart_live', 'orphan_held_counterpart_queued'])
      expect(c, guard).toMatch(new RegExp(guard))
  })

  it('re-checks status on write, so a row that changed underneath is not moved', () => {
    expect(code(WORKER)).toMatch(/\.eq\('id', row\.id\)[\s\S]{0,120}\.eq\('status', 'approved'\)/)
  })

  // ── The notification. ──
  it('interest_expired exists, with copy that assigns no fault', () => {
    expect(NOTIF).toMatch(/\| 'interest_expired'/)
    expect(NOTIF).toMatch(/This introduction has closed — no response within 14 days\./)
    // The counterpart may never have been shown anything actionable, so blaming them is
    // unsupported. Assert on the COPY OBJECT only — the surrounding comment explains why the
    // fault-assigning wording was rejected, and would otherwise match its own prohibition.
    const copyBlock = NOTIF.slice(NOTIF.indexOf('interest_expired: {'),
                                  NOTIF.indexOf('interest_received: {'))
    expect(copyBlock).toMatch(/no response within 14 days/)
    expect(copyBlock).not.toMatch(/did ?n[o']t respond|they ignored|failed to respond/i)
  })

  it('fires on a successful close, to the expresser, and is non-fatal', () => {
    const c = code(WORKER)
    expect(c).toMatch(/type: 'interest_expired'/)
    expect(c).toMatch(/userId: row\.requester_id/)
    expect(c).toMatch(/orphan_notify_failed/)          // a failed notify never re-opens the row
  })

  it('dedupes per ROW, not per 24h — two cards closing the same day both notify', () => {
    expect(code(WORKER)).toMatch(/dedupeKey: row\.id/)
  })

  // ── The decision that is easiest to undo by accident. ──
  it('the backfill is silent and says so in BOTH files', () => {
    expect(BACKFILL).toMatch(/THIS BACKFILL IS SILENT, BY DECISION/)
    expect(WORKER).toMatch(/THE BACKFILL IS SILENT, DELIBERATELY\. DO NOT "FIX" THIS\./)
    // It writes SQL directly and must never invoke the notifier. Checked on EXECUTABLE SQL only:
    // the header comment names 'interest_expired' precisely to say it does not fire one.
    const sqlOnly = BACKFILL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(sqlOnly).not.toMatch(/createNotificationSafe|interest_expired/)
  })

  it('the backfill defaults to a dry run', () => {
    expect(BACKFILL).toMatch(/v_apply constant boolean := false/)
    expect(BACKFILL).toMatch(/DRY RUN: v_apply is false/)
  })
})
