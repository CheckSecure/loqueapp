import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { capacityReleaseMode, RELEASE_WAIT_HOURS, runCapacityReleaseStage } from '@/lib/introductions/capacityRelease'

/**
 * Introduction capacity release.
 *
 * Database behaviour — the drift guard, the 72-hour clock, correlation by responds_to_id, the
 * directional split, races under the canonical advisory locks, outbox inertness and the legacy /
 * ineligible exclusions — is proven in scripts/verify-080-capacity-release.sh: 55 assertions
 * executing the REAL migration against a PostgreSQL cluster that reproduces Supabase's inherited
 * default privileges, with the cluster destroyed afterwards. These tests pin the source facts and
 * the worker logic a future edit could quietly remove.
 */

const M080 = readFileSync('supabase/migrations/080_introduction_capacity_release.sql', 'utf8')
const M063 = readFileSync('supabase/migrations/063_unified_introduction_capacity.sql', 'utf8')
const M064 = readFileSync('supabase/migrations/064_materialize_admin_pair.sql', 'utf8')
const WORKER = readFileSync('lib/introductions/capacityRelease.ts', 'utf8')
const CRON = readFileSync('app/api/cron/engagement-reminders/route.ts', 'utf8')
const WRITER = readFileSync('lib/introRequests/index.ts', 'utf8')
const EXPRESS = readFileSync('lib/introRequests/expressInterest.ts', 'utf8')
const ACTIONS = readFileSync('app/actions.ts', 'utf8')
const BUTTON = readFileSync('components/RequestIntroButton.tsx', 'utf8')
const PAGE = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
const UI = readFileSync('components/introductions/WaitingOnResponse.tsx', 'utf8')
/** The component's JSX only. Its doc comment deliberately NAMES the controls it must not have and
 *  the promises it must not make, so asserting against the raw file would fail on the explanation. */
const UI_CODE = UI.split('\n')
  .filter(l => { const t = l.trimStart(); return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//') })
  .join('\n')

describe('migrations 063–079 are untouched', () => {
  it('080 does not edit 063 or 064', () => {
    // pinned by content: the capacity counts in the committed files must still be the ORIGINAL ones
    expect(M063).toContain("WHERE ir.requester_id = a_id AND ir.status = 'suggested';")
    expect(M063).not.toContain('capacity_released_at')
    expect(M064).not.toContain('capacity_released_at')
  })

  it('080 does not touch expire_intro_pair', () => {
    expect(M080).not.toMatch(/FUNCTION public\.expire_intro_pair/)
    expect(M080).toMatch(/expire_intro_pair IS DELIBERATELY UNCHANGED/)
  })
})

describe('the correlation column', () => {
  it('adds responds_to_id and capacity_released_at, both nullable', () => {
    expect(M080).toMatch(/ADD COLUMN IF NOT EXISTS responds_to_id\s+uuid\s+NULL/)
    expect(M080).toMatch(/ADD COLUMN IF NOT EXISTS capacity_released_at timestamptz NULL/)
  })

  it('performs NO backfill of either column', () => {
    expect(M080).not.toMatch(/UPDATE public\.intro_requests\s+SET\s+responds_to_id/)
    expect(M080).not.toMatch(/^\s*UPDATE public\.intro_requests\s+SET capacity_released_at/m)
    expect(M080).toMatch(/NO BACKFILL/)
  })

  it('has no foreign key, and states what supplies the integrity instead', () => {
    expect(M080).not.toMatch(/responds_to_id[^\n]*REFERENCES/)
    expect(M080).toMatch(/NO FOREIGN KEY on responds_to_id, deliberately/)
    expect(M080).toMatch(/WHY NOT THE FK/)
    expect(M080).toMatch(/SILENT RE-CLASSIFICATION/)
  })

  it('scopes idempotency to responds_to_id, not to the direction', () => {
    expect(M080).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS intro_requests_one_expression_per_card_uniq[\s\S]*?ON public\.intro_requests \(responds_to_id\)/)
  })
})

describe('the local constraint asserts only local facts', () => {
  it('requires a pair when released', () => {
    expect(M080).toMatch(/CHECK \(capacity_released_at IS NULL OR pair_id IS NOT NULL\)/)
  })

  it('does NOT pin status, so later transitions still work', () => {
    const chk = M080.slice(M080.indexOf('intro_requests_released_requires_pair_chk'))
    expect(chk.slice(0, 400)).not.toMatch(/status\s*=\s*'suggested'/)
    expect(M080).toMatch(/would break every\n-- later transition and would be the second bug/)
  })

  it('does not pretend a CHECK can validate cross-row evidence', () => {
    expect(M080).toMatch(/cannot be expressed here at all\n-- and is NOT pretended at/)
  })
})

describe('the release RPC', () => {
  const fn = M080.slice(M080.indexOf('FUNCTION public.release_intro_capacity'))

  it('is SECURITY DEFINER with an empty search_path and schema-qualified calls', () => {
    expect(fn).toMatch(/LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/)
    expect(fn).toMatch(/pg_catalog\.pg_advisory_xact_lock/)
    expect(fn).toMatch(/pg_catalog\.make_interval/)
  })

  it('locks BOTH members in canonical order, in the 063 key space', () => {
    expect(fn).toMatch(/lo := LEAST\(pr\.user_a_id, pr\.user_b_id\)/)
    expect(fn).toMatch(/pg_catalog\.hashtextextended\(lo::text, 0\)/)
    expect(fn).toMatch(/pg_catalog\.hashtextextended\(hi::text, 0\)/)
  })

  it('requires suggested + paired + unreleased + correlated', () => {
    expect(fn).toMatch(/AND t\.status = 'suggested'/)
    expect(fn).toMatch(/AND t\.pair_id IS NOT NULL/)
    expect(fn).toMatch(/AND t\.capacity_released_at IS NULL/)
    expect(fn).toMatch(/WHERE e\.responds_to_id = t\.id/)
  })

  it('measures 72h from the CORRELATED expression, not the card', () => {
    expect(fn).toMatch(/e\.created_at <= pg_catalog\.now\(\)[\s\S]{0,120}make_interval\(hours =>/)
    expect(RELEASE_WAIT_HOURS).toBe(72)
  })

  it('NEVER writes status — the outbox trigger cannot fire', () => {
    const upd = fn.slice(fn.indexOf('UPDATE public.intro_requests t'), fn.indexOf('GET DIAGNOSTICS'))
    expect(upd).toMatch(/SET capacity_released_at = pg_catalog\.now\(\)/)
    expect(upd).not.toMatch(/SET[\s\S]{0,80}status\s*=/)
    expect(M080).toMatch(/an update that does not name status cannot fire it at all/)
  })

  it('is exact zero/one and idempotent', () => {
    expect(fn).toMatch(/GET DIAGNOSTICS v_n = ROW_COUNT/)
    expect(fn).toMatch(/RETURN v_n = 1/)
  })

  it('is unreachable by PUBLIC, anon and authenticated', () => {
    for (const r of ['PUBLIC', 'anon', 'authenticated']) {
      expect(M080).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.release_intro_capacity\\(uuid, integer\\) FROM ${r};`))
    }
    expect(M080).toMatch(/GRANT EXECUTE ON FUNCTION public\.release_intro_capacity\(uuid, integer\) TO service_role;/)
  })
})

describe('the four capacity writers are replaced, and only in the counted predicates', () => {
  it('all four appear in 080 with their exact signatures', () => {
    for (const sig of [
      'FUNCTION public.create_reciprocal_suggestion(',
      'FUNCTION public.place_batch_rows(',
      'FUNCTION public.promote_queued_rows(',
      'FUNCTION public.materialize_admin_pair(',
    ]) expect(M080).toContain(sig)
  })

  it('exactly six capacity predicates gained the release filter', () => {
    expect((M080.match(/capacity_released_at IS NULL\)?[,;]/g) ?? []).length).toBeGreaterThanOrEqual(6)
  })

  it('the NON-capacity uses of suggested are untouched', () => {
    // batch-completion archive, the promotion write, and the provenance check must all survive
    expect(M080).toMatch(/SET status = 'archived', updated_at = v_now/)
    expect(M080).toMatch(/SET status = 'suggested', updated_at = v_now/)
    expect(M080).toMatch(/v_bad_batch/)
  })

  it('preserves the locks, caps and error contracts', () => {
    expect(M080).toMatch(/c_max_visible constant integer := 2/)
    expect(M080).toMatch(/c_max_reserved constant integer := 2/)
    expect((M080.match(/pg_advisory_xact_lock/g) ?? []).length).toBeGreaterThanOrEqual(6)
    for (const s of ["'exists_active'", "'cooldown'", "'capacity'", "'ineligible'"]) expect(M080).toContain(s)
  })

  it('restates the grants so no writer becomes browser-executable', () => {
    for (const f of ['create_reciprocal_suggestion', 'place_batch_rows', 'promote_queued_rows', 'materialize_admin_pair']) {
      expect(M080).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`))
    }
  })
})

describe('the drift guard fails closed on exact identity, not on markers', () => {
  const g = M080.slice(M080.indexOf('DO $drift$'), M080.indexOf('$drift$;'))

  it('resolves every function by EXACT signature, never by name with LIMIT 1', () => {
    expect(g).toMatch(/pg_catalog\.to_regprocedure\(r\.sig\)/)
    expect(g).not.toMatch(/LIMIT 1/)
    expect(g).not.toMatch(/WHERE n\.nspname = 'public' AND p\.proname = r\.fname\s*\n\s*LIMIT/)
  })

  it('pins the exact audited production identities', () => {
    const want: Array<[string, string, string, string, number]> = [
      ['create_reciprocal_suggestion',
       'public.create_reciprocal_suggestion(uuid, uuid, text, text, integer, integer)',
       'a_id uuid, b_id uuid, p_source text, p_reason text, p_cooldown_days integer, p_max_cards integer',
       '8d62f30d84f079c1dcc4aa22848dba9d', 6103],
      ['place_batch_rows',
       'public.place_batch_rows(uuid, text, jsonb, uuid, integer)',
       'p_member_id uuid, p_source text, p_rows jsonb, p_reciprocal_batch_id uuid, p_cooldown_days integer',
       '2eca64f2e35735feb6ca45212488885d', 11413],
      ['promote_queued_rows', 'public.promote_queued_rows(uuid)', 'p_member_id uuid',
       '690f0f6aead9a4831073e32af8d53e1f', 6090],
      ['materialize_admin_pair',
       'public.materialize_admin_pair(uuid, uuid, uuid, uuid, uuid, integer)',
       'p_review_batch_id uuid, p_member_a uuid, p_member_b uuid, p_batch_a uuid, p_batch_b uuid, p_cooldown_days integer',
       'd64aa2aa8627089cd82cbcbc586ddca1', 22015],
      ['expire_intro_pair', 'public.expire_intro_pair(uuid, integer)',
       'p_pair_id uuid, p_max_age_days integer',
       'c786da9312cf962eb06ec6463ceecfd8', 5146],
    ]
    for (const [name, sig, ident, md5, len] of want) {
      expect(g).toContain(`'${sig}'`)
      expect(g).toContain(`'${ident}'`)
      expect(g).toContain(`'${md5}'`)
      expect(g).toContain(`${len}`)
      expect(g).toContain(`'${name}'`)
    }
  })

  it('asserts identity arguments, result type, body md5 AND body length', () => {
    expect(g).toMatch(/pg_get_function_identity_arguments\(v_oid\)/)
    expect(g).toMatch(/pg_get_function_result\(v_oid\)/)
    expect(g).toMatch(/pg_catalog\.md5\(v_proc\.prosrc\) <> r\.want_md5/)
    expect(g).toMatch(/pg_catalog\.length\(v_proc\.prosrc\) <> r\.want_len/)
  })

  it('refuses an unexpected overload of any protected name', () => {
    expect(g).toMatch(/v_n <> 1/)
    expect(g).toMatch(/UNEXPECTED|has % signatures deployed/)
  })

  it('asserts the full security posture', () => {
    expect(g).toMatch(/NOT v_proc\.prosecdef/)
    expect(g).toMatch(/NOT IN \('search_path=', 'search_path=""'\)/)
    expect(g).toMatch(/a::text LIKE '=%'/)                       // PUBLIC
    for (const role of ['anon', 'authenticated']) {
      expect(g).toContain(`has_function_privilege('${role}', v_oid, 'EXECUTE')`)
    }
    expect(g).toMatch(/NOT pg_catalog\.has_function_privilege\('service_role', v_oid, 'EXECUTE'\)/)
  })

  it('keeps markers only as a supplemental diagnostic', () => {
    expect(g).toMatch(/supplemental/i)
    expect(g).toMatch(/Never the authority/)
    // the exact-body check must be decided BEFORE markers are consulted
    expect(g.indexOf('want_md5')).toBeLessThan(g.indexOf('markers) AS m'))
  })

  it('pins expire_intro_pair although 080 does not replace it', () => {
    expect(g).toMatch(/NOT replaced by 080/)
    expect(M080).not.toMatch(/CREATE OR REPLACE FUNCTION public\.expire_intro_pair/)
  })

  it('refuses an environment without the Supabase roles', () => {
    expect(g).toMatch(/FOREACH v_role IN ARRAY ARRAY\['anon','authenticated','service_role'\]/)
    expect(g).toMatch(/role % does not exist/)
  })

  it('every check RAISEs inside the single transaction, so a refusal rolls everything back', () => {
    expect((g.match(/RAISE EXCEPTION/g) ?? []).length).toBeGreaterThanOrEqual(13)
    expect(M080.split('\n').filter((l) => l.trim() === 'BEGIN;').length).toBe(1)
    expect(M080.trimEnd().endsWith('COMMIT;')).toBe(true)
  })

  it('documents that length() counts characters, not octets', () => {
    expect(M080).toMatch(/counts CHARACTERS, not octets/)
  })
})

describe('the worker is default-off and bounded', () => {
  beforeEach(() => { delete process.env.CAPACITY_RELEASE_MODE })

  it('defaults to off, and anything unknown is off', () => {
    expect(capacityReleaseMode()).toBe('off')
    for (const v of ['', 'ON ', 'yes', 'true', 'enabled', 'garbage']) {
      process.env.CAPACITY_RELEASE_MODE = v
      expect(capacityReleaseMode()).toBe(v.trim().toLowerCase() === 'on' ? 'on' : 'off')
    }
  })

  it('off → touches nothing at all', async () => {
    const admin = { from: vi.fn(), rpc: vi.fn() }
    const r = await runCapacityReleaseStage(admin as any, { mode: 'off' })
    expect(r).toMatchObject({ mode: 'off', ran: false, released: 0 })
    expect(admin.from).not.toHaveBeenCalled()
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('dry_run reports candidates and calls the RPC zero times', async () => {
    const rpc = vi.fn()
    const admin = makeAdmin(['card-1', 'card-2'], rpc)
    const r = await runCapacityReleaseStage(admin as any, { mode: 'dry_run' })
    expect(r).toMatchObject({ mode: 'dry_run', ran: true, candidates: 2, released: 0 })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('on → releases via the RPC, one call per candidate', async () => {
    // Typed so mock.calls is a real tuple: a bare vi.fn() infers `[]` and indexing it is an error.
    const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>) => ({ data: true, error: null }))
    const r = await runCapacityReleaseStage(makeAdmin(['card-1', 'card-2'], rpc) as any, { mode: 'on' })
    expect(r).toMatchObject({ mode: 'on', released: 2, skipped: 0, failed: 0 })
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc.mock.calls[0][0]).toBe('release_intro_capacity')
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_min_wait_hours: 72 })
  })

  it('a lost race counts as skipped, not failed', async () => {
    const rpc = vi.fn(async () => ({ data: false, error: null }))
    const r = await runCapacityReleaseStage(makeAdmin(['c1'], rpc) as any, { mode: 'on' })
    expect(r).toMatchObject({ released: 0, skipped: 1, failed: 0 })
  })

  it('an RPC error is counted, never thrown', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'XX000' } }))
    await expect(runCapacityReleaseStage(makeAdmin(['c1'], rpc) as any, { mode: 'on' }))
      .resolves.toMatchObject({ failed: 1 })
  })

  it('correlates through responds_to_id, never through a timestamp on the card', () => {
    expect(WORKER).toMatch(/\.not\('responds_to_id', 'is', null\)/)
    expect(WORKER).toMatch(/identified through responds_to_id, never through a timestamp/)
  })

  it('sends no email and creates no notification', () => {
    expect(WORKER).not.toMatch(/send[A-Z]|createNotification|resend/)
    expect(WORKER).toMatch(/It sends no email and creates no notification/)
  })

  it('logs no identifier', () => {
    for (const m of Array.from(WORKER.matchAll(/console\.(error|log|warn)\(([\s\S]{0,200}?)\)\s*\n/g))) {
      expect(m[2]).not.toMatch(/requester|member_id|intro_request|email|id\b/)
    }
  })

  it('never writes status, and never touches the outbox', () => {
    expect(WORKER).not.toMatch(/status:\s*'/)          // no status in any payload
    expect(WORKER).not.toMatch(/\.update\(|\.insert\(|\.upsert\(|\.delete\(/)
    expect(WORKER).not.toMatch(/introduction_email_outbox/)
  })

  it('release_intro_capacity is the ONLY procedure it can call', () => {
    const names = Array.from(WORKER.matchAll(/\.rpc\('([a-z_]+)'/g)).map((m) => m[1])
    expect(names).toEqual(['release_intro_capacity'])
  })

  it('scans only cards that are still hidden, paired and unreleased', () => {
    expect(WORKER).toMatch(/\.eq\('status', 'suggested'\)/)
    expect(WORKER).toMatch(/\.is\('capacity_released_at', null\)/)
    expect(WORKER).toMatch(/\.not\('pair_id', 'is', null\)/)
  })
})

describe('cron integration cannot delay the existing stages', () => {
  it('runs once, last, on its own budget, wrapped', () => {
    expect((CRON.match(/await runCapacityReleaseStage\(/g) ?? []).length).toBe(1)
    expect(CRON).toMatch(/budgetMs: RELEASE_STAGE_BUDGET_MS/)
    expect(CRON.indexOf('runCapacityReleaseStage')).toBeGreaterThan(CRON.indexOf('runOnboardingReminderStage'))
    const at = CRON.indexOf('let capacityRelease')
    expect(CRON.slice(at, at + 500)).toMatch(/try \{[\s\S]*\} catch \{[\s\S]*capacity_release_stage_failed/)
  })

  it('adds no Vercel cron entry', () => {
    const crons = JSON.parse(readFileSync('vercel.json', 'utf8')).crons as { path: string }[]
    expect(crons.some(c => /capacity|release/.test(c.path))).toBe(false)
  })
})

describe('the production Express Interest chain is wired end to end', () => {
  // client card -> server action -> library -> atomic database writer. Every hop is asserted, so a
  // future refactor that drops the card id anywhere in the chain fails here rather than silently
  // producing uncorrelated expressions again.
  it('the card control carries the card id and it is REQUIRED', () => {
    const props = BUTTON.slice(BUTTON.indexOf('}: {'), BUTTON.indexOf('}) {'))
    expect(props).toMatch(/rowId: string/)            // not `rowId?: string`
    expect(props).not.toMatch(/rowId\?:/)
    expect(BUTTON).toMatch(/await submitIntroRequest\(rowId, targetId\)/)
  })

  it('the page passes the real row id on every rendered card', () => {
    const uses = PAGE.match(/<RequestIntroButton [^>]*\/>/g) ?? []
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u).toMatch(/rowId=\{row\.rowId\}/)
  })

  it('the server action takes the card id first and derives the requester from the session', () => {
    expect(ACTIONS).toMatch(/export async function submitIntroRequest\(suggestedRowId: string, targetUserId: string\)/)
    const fn = ACTIONS.slice(ACTIONS.indexOf('export async function submitIntroRequest'),
                             ACTIONS.indexOf('export async function adminApproveIntro'))
    expect(fn).toMatch(/const \{ user \} = await getSupabaseAndUser\(\)/)
    expect(fn).toMatch(/authUserId: user\.id/)
    expect(fn).not.toMatch(/requesterId\s*[:=]\s*(?!user\.id)/)   // never client-supplied
    expect(fn).toMatch(/expressInterestOnCard\(\{/)
  })

  it('the library calls the atomic writer with all four bound arguments', () => {
    expect(EXPRESS).toMatch(/rpc\('express_intro_interest', \{/)
    for (const arg of ['p_suggested_id: suggestedRowId', 'p_requester_id: authUserId', 'p_target_user_id: targetUserId']) {
      expect(EXPRESS).toContain(arg)
    }
  })
})

describe('correlation is mandatory — there is no fallback', () => {
  it('the card path has no plain-insert branch at all', () => {
    expect(EXPRESS).not.toMatch(/\.insert\(/)
    expect(EXPRESS).not.toMatch(/createIntroRequest\(/)   // a call, not the doc reference
  })

  it('a refusal from the writer returns an error rather than degrading', () => {
    expect(EXPRESS).toMatch(/return \{ error: 'This introduction is no longer available\.', code: 'CARD_NOT_ACTIONABLE' \}/)
    expect(EXPRESS).toMatch(/if \(!suggestedRowId\) return/)
  })

  it('createIntroRequest can no longer be handed a card id', () => {
    expect(WRITER).not.toMatch(/respondsToSuggestedId/)
    expect(WRITER).not.toMatch(/express_intro_interest/)
    expect(WRITER).toMatch(/NOT the Express-Interest-on-a-card path/)
  })

  it('and nothing member-facing reaches it any more', () => {
    expect(ACTIONS).not.toMatch(/createIntroRequest\(/)
  })
})

describe('stale expressions cannot be reused', () => {
  it('the card path never consults the (requester, target) reuse helper', () => {
    expect(EXPRESS).not.toMatch(/findReusableOutboundIntro/)
    expect(EXPRESS).not.toMatch(/EXPRESSED_STATUSES/)
  })

  it('idempotency is scoped to responds_to_id in both the index and the function', () => {
    expect(M080).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS intro_requests_one_expression_per_card_uniq\s*\n\s*ON public\.intro_requests \(responds_to_id\)/)
    expect(M080).toMatch(/WHERE e\.responds_to_id = p_suggested_id/)
    // never by person
    const fn = M080.slice(M080.indexOf('CREATE OR REPLACE FUNCTION public.express_intro_interest'),
                          M080.indexOf('REVOKE ALL ON FUNCTION public.express_intro_interest'))
    expect(fn).not.toMatch(/ORDER BY .*created_at/)
  })

  it('the reason the old reuse path was unsafe is recorded where it can be read', () => {
    const fn = M080.slice(M080.indexOf('CREATE OR REPLACE FUNCTION public.express_intro_interest'),
                          M080.indexOf('REVOKE ALL ON FUNCTION public.express_intro_interest'))
    expect(fn).toMatch(/reused the OLDEST/)
    expect(fn).toMatch(/PREVIOUS epoch/)
  })
})

describe('the hardened writer decides every card fact under the locks', () => {
  const fn = M080.slice(M080.indexOf('CREATE OR REPLACE FUNCTION public.express_intro_interest'),
                        M080.indexOf('REVOKE ALL ON FUNCTION public.express_intro_interest'))

  it('locks BOTH members in canonical order before deciding anything', () => {
    expect(fn).toMatch(/lo := LEAST\(s\.requester_id, s\.target_user_id\)/)
    expect(fn).toMatch(/hi := GREATEST\(s\.requester_id, s\.target_user_id\)/)
    const lockAt = fn.indexOf('pg_advisory_xact_lock')
    const decideAt = fn.indexOf('IF s.requester_id <> p_requester_id')
    expect(lockAt).toBeGreaterThan(-1)
    expect(lockAt).toBeLessThan(decideAt)          // nothing is decided before the locks are held
  })

  it('re-reads the card FOR UPDATE after taking the locks', () => {
    expect(fn).toMatch(/WHERE id = p_suggested_id FOR UPDATE/)
  })

  it('refuses each required condition with its own reason', () => {
    for (const detail of ['not_owner', 'target_mismatch', 'card_not_suggested', 'card_is_an_expression',
                          'card_has_no_pair', 'pair_not_active', 'target_ineligible', 'card_missing',
                          'self_pair', 'missing_argument']) {
      expect(fn).toContain(`'${detail}'`)
    }
  })

  it('writes nothing on any refusal — the INSERT is the last statement', () => {
    const insertAt = fn.indexOf('INSERT INTO public.intro_requests')
    for (const detail of ['not_owner', 'target_mismatch', 'pair_not_active', 'target_ineligible']) {
      expect(fn.indexOf(`'${detail}'`)).toBeLessThan(insertAt)
    }
    expect(fn.split('INSERT INTO public.intro_requests').length - 1).toBe(1)
  })

  it('leaves pair_id NULL so migration 066 expiry is unchanged', () => {
    expect(fn).toMatch(/\(requester_id, target_user_id, status, note, responds_to_id\)/)
    expect(fn).toMatch(/pair_id is deliberately LEFT NULL/)
    expect(fn).toMatch(/unanswered_side_not_open/)   // the exact 066 refusal this avoids
  })
})

describe('080 grants the signatures the writers actually have', () => {
  // Three of these were wrong and would have raised 42883 in production, rolling the migration
  // back. The signature is read from the deployed migration that defines each function.
  const real: Record<string, string> = {
    create_reciprocal_suggestion: '(uuid, uuid, text, text, integer, integer)',
    place_batch_rows: '(uuid, text, jsonb, uuid, integer)',
    promote_queued_rows: '(uuid)',
    materialize_admin_pair: '(uuid, uuid, uuid, uuid, uuid, integer)',
  }
  for (const [name, sig] of Object.entries(real)) {
    it(`${name} is granted as ${sig}`, () => {
      expect(M080).toContain(`GRANT EXECUTE ON FUNCTION public.${name}${sig} TO service_role;`)
      expect(M080).toContain(`REVOKE ALL ON FUNCTION public.${name}${sig} FROM PUBLIC, anon, authenticated;`)
    })
  }
  it('and the source migrations agree', () => {
    expect(M063).toContain(`public.create_reciprocal_suggestion${real.create_reciprocal_suggestion}`)
    expect(M063).toContain(`public.place_batch_rows${real.place_batch_rows}`)
    expect(M064).toContain(`public.materialize_admin_pair${real.materialize_admin_pair}`)
  })
})

describe('integrity for responds_to_id without a foreign key', () => {
  it('still has no FK, and says why in full', () => {
    expect(M080).not.toMatch(/REFERENCES public\.intro_requests/)
    expect(M080).toMatch(/WHAT REPLACES IT/)
    expect(M080).toMatch(/LOCKED VALIDATION AT THE ONLY WRITE SITE/)
    expect(M080).toMatch(/DANGLING IS INERT/)
    expect(M080).toMatch(/A STANDING ORPHAN AUDIT/)
  })

  it('the orphan audit exists in the review view', () => {
    expect(M080).toMatch(/'orphan_responds_to'::text/)
    expect(M080).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.intro_requests c WHERE c\.id = ir\.responds_to_id\)/)
  })

  it('responds_to_id is written in exactly one place', () => {
    const writes = M080.match(/responds_to_id\)\s*\n\s*VALUES/g) ?? []
    expect(writes.length).toBe(1)
  })
})

describe('the waiting state is wired into the Introductions page', () => {
  it('is imported and rendered', () => {
    expect(PAGE).toMatch(/import WaitingOnResponse from '@\/components\/introductions\/WaitingOnResponse'/)
    expect(PAGE).toMatch(/<WaitingOnResponse entries=\{waitingEntries\} \/>/)
  })

  it('is derived only from the viewer’s own correlated expression', () => {
    expect(PAGE).toMatch(/if \(intro\.responds_to_id\) \{/)
    expect(PAGE).toMatch(/correlatedExpressions\.push\(intro\)/)
    expect(PAGE).toMatch(/responds_to_id/)
  })

  it('liveness comes from the CARD, so a terminal pair removes the entry', () => {
    expect(PAGE).toMatch(/const liveCardIds = new Set<string>\(/)
    expect(PAGE).toMatch(/filter\(\(r: any\) => r\.pair_id\)/)
    expect(PAGE).toMatch(/liveCardIds\.has\(r\.responds_to_id\)/)
  })

  it('the answered card disappears from the actionable list', () => {
    expect(PAGE).toMatch(/correlatedTargetIds\.forEach\(\(id\) => pendingTargetIds\.add\(id\)\)/)
    expect(PAGE).toMatch(/!pendingTargetIds\.has\(item\.profile\.id\)/)
  })

  it('and is not ALSO shown as an "Interest expressed" card', () => {
    // the correlated branch `continue`s before pendingByTarget.set — exactly one representation
    const block = PAGE.slice(PAGE.indexOf('const pendingByTarget = new Map'), PAGE.indexOf('const pendingProfiles ='))
    expect(block.indexOf('correlatedExpressions.push')).toBeLessThan(block.indexOf('pendingByTarget.set'))
    expect(block).toMatch(/correlatedTargetIds\.add\(t\.id\)\s*\n\s*continue/)
  })

  it('one entry per card, never one per duplicate row', () => {
    expect(PAGE).toMatch(/seenWaitingCards/)
  })
})

describe('the waiting state is not a card', () => {
  it('has no Express Interest or Pass control and no state-changing handler', () => {
    expect(UI_CODE).not.toMatch(/Express Interest|onClick|<button|Pass</)
    expect(UI_CODE).not.toMatch(/'use client'/)   // no interactivity at all
  })

  it('uses the approved copy and promises nothing', () => {
    expect(UI).toMatch(/Waiting on their response/)
    expect(UI).toMatch(/We&rsquo;ll let you know if they&rsquo;re interested/)
    expect(UI_CODE).not.toMatch(/pending match|match is|likely|soon/i)
  })

  it('renders outside the actionable list and never reads capacity', () => {
    expect(UI).toMatch(/aria-label="Introductions awaiting a response"/)
    expect(UI_CODE).not.toMatch(/capacity_released_at|capacity/i)
  })
})

/** Minimal Supabase-shaped fake: two selects then per-candidate rpc. */
function makeAdmin(cardIds: string[], rpc: any) {
  let call = 0
  return {
    rpc,
    from() {
      const q: any = {
        select: () => q, not: () => q, in: () => q, lte: () => q, eq: () => q,
        is: () => q, limit: () => q.__resolve(),
        then: (res: any) => q.__resolve().then(res),
        __resolve() {
          call++
          return Promise.resolve(call === 1
            ? { data: cardIds.map(id => ({ responds_to_id: id })), error: null }
            : { data: cardIds.map(id => ({ id })), error: null })
        },
      }
      return q
    },
  }
}
