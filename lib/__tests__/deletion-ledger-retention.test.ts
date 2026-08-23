import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { purgeExpiredDeletionEvents } from '@/lib/account/retentionPurge'

/**
 * The approved seven-year retention decision, pinned where it can be checked.
 *
 * The BEHAVIOURAL proof is scripts/verify-075-deletion-ledger.sh, which applies migration 075 to a
 * real PostgreSQL cluster reproducing Supabase's inherited default privileges and runs 99
 * assertions — including that a 6-years-364-days row survives, a 7-years-1-day row is removed, an
 * ordinary DELETE is still refused after the purge has run, and the purge marker cannot be forged
 * from outside the function. These assertions guard what a future edit could remove silently.
 */

const MIG = readFileSync('supabase/migrations/075_account_deletion_ledger.sql', 'utf8')
const PURGE = readFileSync('lib/account/retentionPurge.ts', 'utf8')
const CRON = readFileSync('app/api/cron/engagement-reminders/route.ts', 'utf8')
const PRIVACY = readFileSync('app/privacy/page.tsx', 'utf8')
const TERMS_PAGE = readFileSync('app/terms/page.tsx', 'utf8')
const LEGAL = readFileSync('lib/legal/terms.ts', 'utf8')
const VERCEL = readFileSync('vercel.json', 'utf8')

describe('the purge cannot be aimed', () => {
  it('takes no arguments at all', () => {
    expect(MIG).toMatch(/FUNCTION public\.purge_expired_account_deletion_events\(\)\s*\n\s*RETURNS bigint/)
  })

  it('accepts no user id, email, date, interval or retention period', () => {
    const fn = MIG.slice(MIG.indexOf('FUNCTION public.purge_expired_account_deletion_events'))
    const body = fn.slice(0, fn.indexOf('$fn$;'))
    expect(body).not.toMatch(/\bp_(user|email|id|date|days|interval|years|cutoff|before)\b/)
  })

  it('fixes the seven-year boundary in the body', () => {
    expect(MIG).toMatch(/DELETE FROM public\.account_deletion_events\s*\n\s*WHERE occurred_at < pg_catalog\.now\(\) - pg_catalog\.make_interval\(years => 7\)/)
  })

  it('returns an aggregate count and nothing else', () => {
    expect(MIG).toMatch(/GET DIAGNOSTICS v_removed = ROW_COUNT/)
    expect(MIG).toMatch(/RETURN v_removed;/)
    expect(MIG).toMatch(/must not become a channel for reading the records it deletes/)
  })

  it('is SECURITY DEFINER with an empty search_path and schema-qualified calls', () => {
    expect(MIG).toMatch(/purge_expired_account_deletion_events\(\)\s*\n\s*RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/)
    expect(MIG).toMatch(/pg_catalog\.set_config\('andrel\.retention_purge'/)
    expect(MIG).toMatch(/pg_catalog\.now\(\)/)
  })

  it('is executable by service_role only', () => {
    for (const r of ['PUBLIC', 'anon', 'authenticated']) {
      expect(MIG).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.purge_expired_account_deletion_events\\(\\) FROM ${r};`))
    }
    expect(MIG).toMatch(/GRANT EXECUTE ON FUNCTION public\.purge_expired_account_deletion_events\(\) TO service_role;/)
  })
})

describe('deletion is permitted through exactly one door', () => {
  it('refuses UPDATE and TRUNCATE unconditionally', () => {
    const fn = MIG.slice(MIG.indexOf('FUNCTION public.tg_account_deletion_events_append_only'))
    expect(fn).toMatch(/IF TG_OP <> 'DELETE' THEN\s*\n\s*RAISE EXCEPTION/)
    expect(fn).toMatch(/There is no marker, flag or\n  -- privilege that unlocks them/)
  })

  it('gates DELETE on a transaction-local marker only the purge sets', () => {
    const fn = MIG.slice(MIG.indexOf('FUNCTION public.tg_account_deletion_events_append_only'))
    expect(fn).toMatch(/current_setting\('andrel\.retention_purge', true\) IS DISTINCT FROM 'on'/)
    expect(fn).toMatch(/permitted only through public\.purge_expired_account_deletion_events\(\)/)
    // transaction-local: the third argument to set_config must be true
    expect(MIG).toMatch(/set_config\('andrel\.retention_purge', 'on', true\)/)
  })

  it('re-checks the seven-year boundary in the trigger, so editing the purge cannot widen it', () => {
    const fn = MIG.slice(MIG.indexOf('FUNCTION public.tg_account_deletion_events_append_only'))
    expect(fn).toMatch(/OLD\.occurred_at >= pg_catalog\.now\(\) - pg_catalog\.make_interval\(years => 7\)/)
    expect(fn).toMatch(/the\n  -- table itself refuses to give up a row that is not yet seven years old/)
  })

  it('builds no arbitrary per-user deletion endpoint', () => {
    expect(MIG).toMatch(/no arbitrary\n-- per-user deletion endpoint exists/)
    expect(PURGE).not.toMatch(/userId|deletedUserId|email/)
  })

  it('performs no historical backfill', () => {
    expect(MIG).toMatch(/NO BACKFILL/)
    expect(MIG).not.toMatch(/INSERT INTO public\.account_deletion_events[\s\S]{0,200}SELECT[\s\S]{0,200}FROM public\.profiles/)
  })
})

describe('the purge helper leaks nothing and never throws', () => {
  it('returns an aggregate count on success', async () => {
    const client = { rpc: vi.fn(async () => ({ data: 4, error: null })) }
    await expect(purgeExpiredDeletionEvents(client)).resolves.toEqual({ removed: 4 })
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith('purge_expired_account_deletion_events')
  })

  it('passes NO arguments to the RPC', async () => {
    const client = { rpc: vi.fn(async () => ({ data: 0, error: null })) }
    await purgeExpiredDeletionEvents(client)
    expect(client.rpc.mock.calls[0]).toHaveLength(1) // function name only — no date, no target
  })

  it('classifies an RPC error instead of propagating it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = { rpc: async () => ({ data: null, error: { code: '42501', message: 'permission denied for user alex@x.com' } }) }
    await expect(purgeExpiredDeletionEvents(client)).resolves.toEqual({ removed: null, errorClass: 'rpc_error' })
    const logged = err.mock.calls.flat().join(' ')
    expect(logged).not.toContain('alex@x.com')
    expect(logged).not.toContain('permission denied')
    expect(logged).toContain('42501')
    err.mockRestore()
  })

  it('never throws, even when the client itself does', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = { rpc: async () => { throw new Error('boom') } }
    await expect(purgeExpiredDeletionEvents(client)).resolves.toEqual({ removed: null, errorClass: 'unavailable' })
    err.mockRestore()
  })
})

describe('cron integration', () => {
  it('runs once per maintenance run, last, in the existing authenticated cron', () => {
    expect(CRON).toMatch(/import \{ purgeExpiredDeletionEvents \} from '@\/lib\/account\/retentionPurge'/)
    // exactly ONE invocation in the whole route — "once per maintenance run" is the requirement
    expect((CRON.match(/await purgeExpiredDeletionEvents\(/g) ?? []).length).toBe(1)
    expect((CRON.match(/purgeExpiredDeletionEvents\(/g) ?? []).length).toBe(1)
    expect(CRON.indexOf('await purgeExpiredDeletionEvents')).toBeGreaterThan(CRON.indexOf('await drainIntroductionOutbox'))
  })

  it('preserves the existing CRON_SECRET authorization untouched', () => {
    expect(CRON).toMatch(/if \(auth !== `Bearer \$\{process\.env\.CRON_SECRET\}`\) \{/)
  })

  it('cannot interfere with the reminder, expiry or outbox stages', () => {
    const at = CRON.indexOf('let ledgerRetention')
    expect(CRON.slice(at, at + 500)).toMatch(/try \{[\s\S]*\} catch \{[\s\S]*errorClass: 'unavailable'/)
  })

  it('returns aggregate outcome only — no identity in the response', () => {
    expect(CRON).toMatch(/Aggregate count and a safe class only — never an id, a timestamp or a sample row/)
    expect(PURGE).toMatch(/removed: number \| null/)
    expect(PURGE).not.toMatch(/deletion_id|deleted_user_id|occurred_at/)
  })

  it('adds no new Vercel cron entry', () => {
    const crons = JSON.parse(VERCEL).crons as Array<{ path: string }>
    expect(crons.some(c => c.path.includes('purge') || c.path.includes('retention'))).toBe(false)
    expect(crons.some(c => c.path === '/api/cron/engagement-reminders')).toBe(true)
  })
})

describe('legal surfaces', () => {
  it('Privacy §5 carries the approved language verbatim', () => {
    for (const fragment of [
      'When an account is deleted, Andrel removes or de-identifies the associated account and profile information.',
      'We may retain a limited deletion audit record for up to seven years where reasonably necessary for security, fraud prevention, legal compliance, dispute resolution, and enforcement of our Terms.',
      'This record contains only an internal account identifier, the date and status of the deletion, and categories describing how it was initiated.',
      'We periodically review these records and delete them when they are no longer reasonably necessary.',
    ]) {
      expect(PRIVACY).toContain(fragment)
    }
    // the apostrophe is escaped for JSX, so the sentence is asserted around it
    expect(PRIVACY).toContain('It does not contain the member&rsquo;s name, email address, profile information, messages, or other account content.')
  })

  it('bumps the Privacy version and effective date through the shared constants', () => {
    expect(LEGAL).toMatch(/export const PRIVACY_VERSION = 2/)
    expect(LEGAL).toMatch(/export const PRIVACY_VERSION_LABEL = '2\.0'/)
    expect(LEGAL).toMatch(/export const PRIVACY_EFFECTIVE_DATE = 'August 22, 2026'/)
  })

  it('leaves the Terms version completely alone', () => {
    expect(LEGAL).toMatch(/export const TERMS_VERSION = 1/)
    expect(LEGAL).toMatch(/export const TERMS_VERSION_LABEL = '1\.0'/)
    expect(LEGAL).toMatch(/export const TERMS_EFFECTIVE_DATE = 'July 27, 2026'/)
  })

  it('leaves the Terms page byte-identical', () => {
    // pinned by hash: any edit at all fails this
    const h = require('node:crypto').createHash('sha256').update(readFileSync('app/terms/page.tsx')).digest('hex')
    expect(h).toBe('fda912a97ee96e1718a9d3e349a1cc59b00d9665011e228191e40e1688832c29')
  })

  it('preserves the policy-change notice provision', () => {
    expect(PRIVACY).toContain('We will notify you of material changes by email or by posting a notice on the platform.')
    expect(PRIVACY).toMatch(/10\. Changes to This Policy/)
  })

  it('keeps the version display driven by the constants, not hardcoded', () => {
    expect(PRIVACY).toMatch(/Version \{PRIVACY_VERSION_LABEL\} · Effective: \{PRIVACY_EFFECTIVE_DATE\}/)
    expect(PRIVACY).not.toMatch(/Version 2\.0/)
  })
})
