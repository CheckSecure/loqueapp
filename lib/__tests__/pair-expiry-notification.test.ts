import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const WORKER = readFileSync('lib/introductions/expiryWorker.ts', 'utf8')
const EXPIRY = readFileSync('lib/introductions/expiry.ts', 'utf8')
const NOTIF = readFileSync('lib/notifications/index.ts', 'utf8')

describe('the pair-expiry notification gap', () => {
  it('surfaces the RPC case, which the wrapper used to drop', () => {
    // Without it the caller cannot tell which side expressed: expire_intro_pair moves every live
    // row to 'expired' in one statement, so the distinction is gone once it returns.
    expect(EXPIRY).toContain("export type PairExpiryCase = 'both_unanswered' | 'one_sided_interest'")
    expect(EXPIRY).toContain('pairCase: (r.case as PairExpiryCase) ?? null')
  })

  it('reads the expresser BEFORE expiring', () => {
    const read = WORKER.indexOf("const { data: preRows } = await admin")
    const call = WORKER.indexOf('await expireIntroPair(admin, r.pair_id')
    expect(read).toBeGreaterThan(-1)
    expect(read).toBeLessThan(call)
    expect(WORKER).toContain("['approved', 'accepted', 'pending'].includes(row?.status)")
  })

  it('notifies ONLY on a confirmed one-sided close', () => {
    // Gated on the RPC's verdict, not the pre-read: if the counterpart acted in between, the RPC
    // returns protected/mutual_pending and nothing is sent.
    expect(WORKER).toContain("res.outcome === 'expired' && res.pairCase === 'one_sided_interest' && expresserRow")
  })

  it('reuses the existing type and its dedupe shape', () => {
    expect(NOTIF).toContain("interest_expired: {")
    expect(WORKER).toContain("type: 'interest_expired'")
    expect(WORKER).toContain('dedupeKey: expresserRow.id')
  })

  it('names the counterpart, falling back to the static copy', () => {
    expect(WORKER).toContain('Your introduction to ${counterpartFirst} has closed')
    expect(WORKER).toContain('...(counterpartFirst')
  })

  it('assigns no fault to the counterpart', () => {
    const helper = WORKER.slice(WORKER.indexOf('async function notifyExpiredExpresser'),
                                WORKER.indexOf('export async function runExpiryStage'))
    const code = helper.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join(' ')
    for (const blame of ['ignored', 'did not respond', "didn't respond", 'no response from']) {
      expect(code.toLowerCase()).not.toContain(blame)
    }
    expect(code).toContain('Your interest stayed private and was never shared.')
  })

  it('reads the counterpart name as service_role, not through the discovery view', () => {
    // This runs in a cron with no session; public_profiles is security_invoker and would return
    // nothing.
    const helper = WORKER.slice(WORKER.indexOf('async function notifyExpiredExpresser'),
                                WORKER.indexOf('export async function runExpiryStage'))
    expect(helper).toContain(".from('profiles')")
    expect(helper).not.toContain('public_profiles')
  })

  it('is non-fatal — a missed notification never re-opens the pair', () => {
    expect(WORKER).toContain("outcomes['pair_notify_failed']")
    expect(WORKER).toContain('pair notify failed (non-fatal)')
  })
})
