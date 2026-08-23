import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * The deletion ledger's guarantees, pinned as source facts.
 *
 * The behavioural proof lives in scripts/verify-075-deletion-ledger.sh, which applies migration 075
 * to a REAL PostgreSQL cluster that reproduces Supabase's inherited default privileges
 * (`ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO service_role`) and then exercises the whole
 * thing end to end: 37 assertions covering privileges, append-only enforcement against the table
 * OWNER, the count-shape constraints, a real deletion, and the fail-closed rollback. That harness
 * exists because a plain local cluster has none of Supabase's default grants — which is exactly why
 * four earlier ACL defects passed local verification and only failed in production.
 *
 * These assertions guard the properties a future edit could quietly remove without any test noticing.
 */

const MIG = readFileSync('supabase/migrations/075_account_deletion_ledger.sql', 'utf8')
const LEDGER = readFileSync('lib/account/deletionLedger.ts', 'utf8')
const REVOKE = readFileSync('app/api/admin/waitlist/revoke/route.ts', 'utf8')
const AUDIT = readFileSync('supabase/audits/forensic_missing_account.sql', 'utf8')

describe('the ledger outlives its subject', () => {
  it('declares no foreign key, so it is neither blocked by nor cascaded with the deletion', () => {
    const table = MIG.slice(MIG.indexOf('CREATE TABLE IF NOT EXISTS public.account_deletion_events'))
    expect(table.slice(0, table.indexOf('CREATE INDEX'))).not.toMatch(/REFERENCES/i)
  })

  it('revokes before granting — a GRANT is additive and only REVOKE removes', () => {
    const revokeAt = MIG.indexOf('REVOKE ALL ON public.account_deletion_events FROM service_role')
    const grantAt = MIG.indexOf('GRANT SELECT, INSERT ON public.account_deletion_events TO service_role')
    expect(revokeAt).toBeGreaterThan(-1)
    expect(grantAt).toBeGreaterThan(revokeAt)
  })

  it('grants service_role exactly SELECT and INSERT, and never a mutating verb', () => {
    const grants = Array.from(MIG.matchAll(/GRANT ([A-Z, ]+) ON public\.account_deletion_events/g))
      .map(m => m[1].trim())
    expect(grants).toEqual(['SELECT, INSERT'])
    // anchored to statement position — the file's prose deliberately quotes Supabase's own
    // `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES`, which is documentation, not a grant.
    expect(MIG).not.toMatch(/^GRANT[^;]*\b(UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL)\b[^;]*ON public\.account_deletion_events/mi)
  })

  it('enables RLS with zero policies, and does not FORCE it', () => {
    expect(MIG).toMatch(/ALTER TABLE public\.account_deletion_events ENABLE ROW LEVEL SECURITY/)
    expect(MIG).not.toMatch(/CREATE POLICY[^;]*account_deletion_events/)
    // FORCE would apply RLS to the owner, silently breaking the SECURITY DEFINER writer.
    expect(MIG).not.toMatch(/FORCE ROW LEVEL SECURITY/)
  })

  it('blocks UPDATE and DELETE by trigger, not merely by privilege', () => {
    expect(MIG).toMatch(/BEFORE UPDATE OR DELETE ON public\.account_deletion_events/)
    expect(MIG).toMatch(/append-only; % is not permitted/)
  })

  it('says out loud that a row trigger does not fire on TRUNCATE', () => {
    expect(MIG).toMatch(/row trigger does NOT fire on TRUNCATE/)
  })

  it('every SECURITY DEFINER function pins an empty search_path', () => {
    // Counted at definition position (indented on its own line), not in prose, which mentions the
    // phrase while explaining why FORCE row security would break the definer.
    // Checked per DEFINITION rather than by counting the phrase, which also appears in the prose
    // explaining why FORCE row security would break the definer.
    const bodies = MIG.split('CREATE OR REPLACE FUNCTION').slice(1)
      .map(b => b.slice(0, b.indexOf('AS $')))
    const definers = bodies.filter(b => /SECURITY DEFINER/.test(b))
    expect(definers.length).toBe(6) // append-only, recorder, capture, truncate-capture, purge, delete_user_account
    for (const d of definers) expect(d).toMatch(/SET search_path = ''/)
    // and every definition schema-qualifies, since an empty search_path resolves nothing
    expect(MIG).not.toMatch(/\n\s+(?:DELETE FROM|INSERT INTO|SELECT \* FROM) (?!public\.|auth\.|pg_catalog\.)[a-z_]+\s/)
  })
})

describe('the ledger structurally cannot hold personal data', () => {
  it('has no column capable of holding an email, name, body, IP, token or payload', () => {
    const table = MIG.slice(
      MIG.indexOf('CREATE TABLE IF NOT EXISTS public.account_deletion_events'),
      MIG.indexOf('CREATE INDEX'))
    expect(table).not.toMatch(/^\s*\w*(email|name|body|content|ip_address|token|payload|snapshot)\w*\s/mi)
  })

  it('constrains object_counts to non-negative whole numbers only', () => {
    expect(MIG).toMatch(/CHECK \(public\.account_deletion_counts_ok\(object_counts\)\)/)
    expect(MIG).toMatch(/jsonb_typeof\(e\.value\) = 'number'/)
    expect(MIG).toMatch(/pg_catalog\.trunc/)
  })

  it('constrains error_class to a slug, so a raw error message cannot be stored', () => {
    expect(MIG).toMatch(/error_class IS NULL OR error_class ~ '\^\[a-z0-9_\]\{1,40\}\$'/)
  })

  it('records the retention purpose and the rejection of an email fingerprint', () => {
    expect(MIG).toMatch(/RETENTION AND ACCESS PURPOSE/)
    expect(MIG).toMatch(/NO EMAIL FINGERPRINT/)
    expect(MIG).toMatch(/NO plain unsalted email hash \(trivially reversible; never an option\)/)
  })
})

describe('the self-service path is fail-closed', () => {
  it('writes the record BEFORE the first destructive statement', () => {
    const fn = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.delete_user_account'))
    expect(fn.indexOf("'requested'")).toBeLessThan(fn.indexOf('DELETE FROM public.messages'))
  })

  it('captures counts before deleting, so they are not all zero', () => {
    const fn = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.delete_user_account'))
    expect(fn.indexOf('INTO v_counts')).toBeLessThan(fn.indexOf('DELETE FROM public.messages'))
  })

  it('preserves the original deletion sequence a–k, in order', () => {
    const fn = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.delete_user_account'))
    const order = ['public.messages', 'public.conversations', 'public.matches', 'public.intro_requests',
      'public.meeting_credits', 'public.credit_transactions', 'public.meetings', 'public.notifications',
      'public.profiles', 'public.waitlist', 'auth.users']
    const positions = order.map(t => fn.indexOf(`DELETE FROM ${t}`))
    expect(positions.every(p => p > -1)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('uses clock_timestamp, because now() would give every event the same timestamp', () => {
    expect(MIG).toMatch(/occurred_at\s+timestamptz NOT NULL DEFAULT clock_timestamp\(\)/)
    expect(MIG).toMatch(/now\(\) is fixed at transaction start/)
  })
})

describe('the admin path claims no atomicity it does not have', () => {
  it('states plainly that the Auth Admin API cannot join the database transaction', () => {
    expect(LEDGER).toMatch(/NO atomicity to be had across an HTTP boundary and a PostgreSQL transaction/)
    expect(MIG).toMatch(/CANNOT share this transaction, and no amount of SQL makes it atomic/)
    expect(MIG).toMatch(/No cross-system atomicity is\n-- claimed anywhere in this design/)
  })

  it('models progress as append-only inserts, never as an UPDATE', () => {
    expect(LEDGER).toMatch(/requested ──▶ data_deleted ──▶ auth_deleted/)
    expect(LEDGER).toMatch(/advancing the state never requires UPDATE/)
  })

  it('treats a ledger row as evidence of an ATTEMPT, not proof of completion', () => {
    expect(LEDGER).toMatch(/never proof of a completed deletion/)
    expect(LEDGER).toMatch(/Only an\n \* `auth_deleted` event means finished/)
  })

  it('refuses the revoke outright when the record cannot be written', () => {
    const at = REVOKE.indexOf('await openDeletion(admin,')
    expect(at).toBeGreaterThan(-1)
    expect(REVOKE.slice(at, at + 600)).toMatch(/if \(!opened\) \{[\s\S]*status: 500/)
    // and it must happen before anything is destroyed
    expect(at).toBeLessThan(REVOKE.indexOf(".from('profiles')\n      .delete()"))
  })

  it('uses the account UUID as deletion_id so app and trigger events converge', () => {
    expect(REVOKE).toMatch(/const deletionId = authUser\?\.id \?\? profile\?\.id \?\? null/)
    expect(REVOKE).toMatch(/CONVERGE on one lifecycle/)
    expect(REVOKE).not.toMatch(/randomUUID/)   // a fresh id would split one deletion into two records
  })

  it('records a class on failure, never the provider message', () => {
    expect(REVOKE).toMatch(/errorClass: delErr && !missing \? 'auth_api_error' : undefined/)
    expect(REVOKE).not.toMatch(/errorClass:.*delErr\.message/)
  })

  it('no longer calls its console.log an audit trail', () => {
    expect(REVOKE).not.toMatch(/Lightweight audit trail/)
    expect(REVOKE).toMatch(/DURABLE record is public\.account_deletion_events/)
  })
})

describe('the forensic audit is read-only and privacy-safe', () => {
  it('contains no mutating keyword at statement position', () => {
    expect(AUDIT).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|DO)\b/mi)
  })

  it('masks the email everywhere it is emitted', () => {
    expect(AUDIT).toMatch(/email_masked/)
    // Every reference to the raw column is either a lower() comparison operand or an argument to
    // split_part() inside the mask. There is no bare selection of the address anywhere.
    for (const line of AUDIT.split('\n').filter(l => l.includes('recipient_email') && !l.trim().startsWith('--'))) {
      expect(line).toMatch(/lower\(\s*d\.recipient_email\s*\)|split_part\(d\.recipient_email/)
    }
  })

  it('never selects message or conversation content', () => {
    expect(AUDIT).not.toMatch(/\b(m\.content|messages\.content|\.body\b)/)
  })

  it('refuses to guess an identifier', () => {
    expect(AUDIT).toMatch(/NO stable user UUID can be recovered/)
    expect(AUDIT).toMatch(/none should be guessed/)
  })

  it('explains why invitation_deliveries is the surviving-evidence candidate', () => {
    expect(AUDIT).toMatch(/no FK/)
    expect(AUDIT).toMatch(/SURVIVE an account deletion/)
  })
})

describe('database-level capture closes the out-of-band hole', () => {
  it('installs BEFORE DELETE triggers on BOTH profiles and auth.users', () => {
    expect(MIG).toMatch(/CREATE TRIGGER capture_profile_deletion\s*\n\s*BEFORE DELETE ON public\.profiles/)
    expect(MIG).toMatch(/CREATE TRIGGER capture_auth_user_deletion\s*\n\s*BEFORE DELETE ON auth\.users/)
  })

  it('justifies the auth.users trigger on production evidence, not assumption', () => {
    expect(MIG).toMatch(/migration 059 records a production preflight/)
    expect(MIG).toMatch(/on_auth_user_email_verified/)
  })

  it('inherits attribution from the application, and records system only when there is none', () => {
    const fn = MIG.slice(MIG.indexOf('FUNCTION public.tg_capture_account_deletion'))
    expect(fn).toMatch(/WHERE e\.deletion_id = v_uid AND e\.stage = 'requested'/)
    expect(fn).toMatch(/v_actor := 'system';/)
    expect(fn).toMatch(/v_path\s*:= 'out_of_band';/)
  })

  it('decides the stage from the firing table rather than guessing', () => {
    expect(MIG).toMatch(/CASE TG_TABLE_SCHEMA WHEN 'auth' THEN 'auth_deleted' ELSE 'data_deleted' END/)
  })

  it('keys idempotency on deletion_id + stage so app and trigger cannot duplicate', () => {
    expect(MIG).toMatch(/v_key := p_deletion_id::text \|\| ':' \|\| p_stage/)
    expect(MIG).toMatch(/ON CONFLICT ON CONSTRAINT account_deletion_events_event_key_uniq DO NOTHING/)
    expect(MIG).toMatch(/whichever arrives second is a no-op instead of a\n  -- conflicting duplicate/)
  })

  it('makes the self-service path use the uuid as deletion_id, for convergence', () => {
    const fn = MIG.slice(MIG.indexOf('CREATE OR REPLACE FUNCTION public.delete_user_account'))
    expect(fn).toMatch(/record_account_deletion_event\(\s*\n?\s*v_uid, 'requested'/)
    expect(fn).not.toMatch(/gen_random_uuid\(\)/)
  })

  it('catches a bulk TRUNCATE of profiles, which no row trigger can see', () => {
    expect(MIG).toMatch(/BEFORE TRUNCATE ON public\.profiles\s*\n\s*FOR EACH STATEMENT/)
    expect(MIG).toMatch(/'profiles_truncated'/)
  })

  it('records the true cascade chronology instead of a tidier fiction', () => {
    expect(MIG).toMatch(/requested -> auth_deleted -> data_deleted/)
    expect(MIG).toMatch(/read the\n  -- lifecycle as a SET of stages, not as a timeline/)
  })

  it('states the fail-closed trade-off rather than burying it', () => {
    expect(MIG).toMatch(/a broken ledger blocks deletions rather than silently losing them/)
  })
})

describe('retention is stated, and not overstated', () => {
  it('names 7 years in the migration and in the table comment', () => {
    expect(MIG).toMatch(/RETENTION PERIOD: SEVEN \(7\) YEARS/)
    expect(MIG).toMatch(/RETENTION: 7 years from occurred_at/)
  })

  it('does not claim indefinite retention, and now names the enforcing mechanism', () => {
    expect(MIG).toMatch(/NOT indefinite retention/)
    expect(MIG).toMatch(/ENFORCED AUTOMATICALLY by public\.purge_expired_account_deletion_events\(\)/)
    expect(MIG).toMatch(/The period is therefore a\n--   mechanism, not merely a commitment/)
    // and the honest limit on earlier removal is still stated
    expect(MIG).toMatch(/Earlier removal is possible only through a documented\n--   legal\/privacy process/)
  })

  it('explicitly revokes the mutating verbs by name after the blanket revoke', () => {
    expect(MIG).toMatch(/REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\s*\n\s*ON public\.account_deletion_events FROM PUBLIC, anon, authenticated, service_role;/)
  })

  it('blocks TRUNCATE of the ledger itself by statement trigger', () => {
    expect(MIG).toMatch(/BEFORE TRUNCATE ON public\.account_deletion_events/)
  })
})

describe('logs leak neither identifiers nor raw errors', () => {
  it('logs only a shape, never the error text', () => {
    expect(LEDGER).toMatch(/code: error\.code \?\? 'unknown'/)
    expect(LEDGER).not.toMatch(/message: error\.message/)
    expect(LEDGER).toMatch(/may echo input, so only its shape is logged/)
  })

  it('logs no email, name or user id from the ledger helper', () => {
    const logs = Array.from(LEDGER.matchAll(/console\.(error|log|warn)\(([\s\S]*?)\)\n/g)).map(m => m[2])
    expect(logs.length).toBeGreaterThan(0)
    for (const l of logs) {
      expect(l).not.toMatch(/email|recipient|full_name|deletedUserId|\buid\b/i)
    }
  })
})
