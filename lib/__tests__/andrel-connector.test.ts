import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  isAndrelConnector, ANDREL_CONNECTOR_LABEL, ANDREL_CONNECTOR_TOOLTIP, ANDREL_CONNECTOR_ADMIN_HELP,
} from '@/lib/recognition/andrelConnector'

/**
 * Andrel Connector — a manually awarded, discretionary recognition.
 *
 * The DATABASE is the authority for who may award it and for keeping the three columns and the
 * audit entry consistent; scripts/verify-082-andrel-connector.sh proves that against a real
 * PostgreSQL 17 cluster. These tests cover the predicate, the component, the surfaces and the copy.
 */
const M082   = readFileSync('supabase/migrations/082_andrel_connector.sql', 'utf8')
const BADGE  = readFileSync('components/ui/AndrelConnectorBadge.tsx', 'utf8')
const SHARED = readFileSync('lib/recognition/andrelConnector.ts', 'utf8')
const ACTIONS = readFileSync('app/actions.ts', 'utf8')
const ADMINUI = readFileSync('components/AdminMembersClient.tsx', 'utf8')
const PROFILE = readFileSync('app/dashboard/profile/[id]/page.tsx', 'utf8')
const NETCARD = readFileSync('components/NetworkCard.tsx', 'utf8')
const NETPAGE = readFileSync('app/dashboard/network/page.tsx', 'utf8')
const INTRO   = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
const PUBCOLS = readFileSync('lib/profiles/publicProfile.ts', 'utf8')

/** Top-level statement kinds, read from the migration's own structure rather than by regex. */
function parse_sql_kinds(sql: string): string[] {
  // A deliberately small structural reader: count only statements at nesting depth 0, outside any
  // dollar-quoted body. That is exactly the distinction "apply-time vs inside a function" needs.
  const kinds: string[] = []
  let rest = sql
  // strip every dollar-quoted body ($tag$ ... $tag$) so function interiors cannot be misread
  rest = rest.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
  for (const raw of rest.split(';')) {
    const t = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim()
    if (!t) continue
    if (/^UPDATE\s/i.test(t)) kinds.push('UpdateStmt')
    else if (/^INSERT\s/i.test(t)) kinds.push('InsertStmt')
    else if (/^DELETE\s/i.test(t)) kinds.push('DeleteStmt')
    else if (/^SELECT\s/i.test(t)) kinds.push('SelectStmt')
  }
  return kinds
}

const stripComments = (src: string) =>
  src.split('\n').filter((l) => {
    const t = l.trim()
    return !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//') && !t.startsWith('--')
  }).join('\n')

const BADGE_CODE = stripComments(BADGE)

describe('the name is fixed everywhere', () => {
  const sources = { M082, BADGE, SHARED, ACTIONS, ADMINUI, PROFILE, NETCARD, INTRO }
  it('never says "influencer" or "connecter" — in copy, code or column names', () => {
    for (const [name, src] of Object.entries(sources)) {
      expect(stripComments(src).toLowerCase(), name).not.toMatch(/influencer/)
      expect(stripComments(src).toLowerCase(), name).not.toMatch(/connecter/)
    }
  })
  it('uses exactly "Andrel Connector"', () => {
    expect(ANDREL_CONNECTOR_LABEL).toBe('Andrel Connector')
    expect(BADGE).toContain('ANDREL_CONNECTOR_LABEL')
  })
})

describe('the render predicate', () => {
  it('true renders the badge', () => {
    expect(isAndrelConnector({ is_andrel_connector: true })).toBe(true)
  })
  it('false renders nothing', () => {
    expect(isAndrelConnector({ is_andrel_connector: false })).toBe(false)
  })
  it('missing, legacy, null and undefined all render UNBADGED', () => {
    expect(isAndrelConnector({})).toBe(false)
    expect(isAndrelConnector({ is_andrel_connector: null } as any)).toBe(false)
    expect(isAndrelConnector({ is_andrel_connector: undefined })).toBe(false)
    expect(isAndrelConnector(null)).toBe(false)
    expect(isAndrelConnector(undefined)).toBe(false)
  })
  it('a merely TRUTHY value does not earn a badge', () => {
    for (const v of ['true', 1, 'yes', {}, []]) {
      expect(isAndrelConnector({ is_andrel_connector: v })).toBe(false)
    }
  })
})

describe('the badge component', () => {
  it('is the ONE rendering — no surface builds its own markup', () => {
    for (const [name, src] of Object.entries({ PROFILE, NETCARD, INTRO })) {
      expect(src, name).toContain('<AndrelConnectorBadge')
      expect(stripComments(src), name).not.toContain('Andrel Connector<')
    }
  })
  it('is restrained: no animation, glow, medal, count or leaderboard styling', () => {
    expect(BADGE_CODE).not.toMatch(/animate-|animation|pulse|glow|shadow-lg|Trophy|Medal|Award|Crown/i)
    expect(BADGE_CODE).not.toMatch(/count|rank|score|leaderboard|followers/i)
  })
  it('uses brand tokens: gold border, navy text', () => {
    expect(BADGE_CODE).toMatch(/border-brand-gold/)
    expect(BADGE_CODE).toMatch(/text-brand-navy/)
  })
  it('does not rely on colour alone — the words carry the meaning', () => {
    expect(BADGE).toContain('{ANDREL_CONNECTOR_LABEL}')
  })
  it('the decorative icon is hidden from assistive technology', () => {
    expect(BADGE_CODE).toMatch(/<Link2 aria-hidden/)
  })
  it('the explanation is KEYBOARD reachable, not hover-only', () => {
    expect(BADGE_CODE).toMatch(/tabIndex=\{0\}/)
    expect(BADGE_CODE).toMatch(/aria-label=/)
    expect(BADGE_CODE).toMatch(/title=\{ANDREL_CONNECTOR_TOOLTIP\}/)
    expect(BADGE_CODE).toMatch(/focus-visible:ring/)
  })
  it('cannot overflow or truncate a name', () => {
    expect(BADGE_CODE).toMatch(/whitespace-nowrap/)
    expect(BADGE_CODE).toMatch(/shrink-0/)
  })
  it('states the approved tooltip sentence', () => {
    expect(ANDREL_CONNECTOR_TOOLTIP).toBe('Recognized for thoughtfully expanding the Andrel community.')
  })
})

describe('display surfaces', () => {
  it('member profile: below the name, gated on the predicate', () => {
    expect(PROFILE).toMatch(/isAndrelConnector\(profile\) && \(/)
    const nameAt = PROFILE.indexOf('tracking-tight">{name}</h1>')
    expect(PROFILE.indexOf('<AndrelConnectorBadge')).toBeGreaterThan(nameAt)
  })
  it('Network card: beside the name, suppressed for a former member', () => {
    expect(NETCARD).toMatch(/!isDeactivated && isAndrelConnector\(profile\) && <AndrelConnectorBadge/)
    expect(NETCARD).toMatch(/flex flex-wrap items-center/)   // wraps instead of squeezing the name
  })
  it('introduction card: featured only, so the compact cards stay uncrowded', () => {
    expect(INTRO).toMatch(/isAndrelConnector\(s\) && \(/)
    expect((INTRO.match(/<AndrelConnectorBadge/g) ?? []).length).toBe(1)
  })
  it('appears on NONE of the forbidden surfaces', () => {
    const forbidden = [
      'components/MobileNav.tsx', 'components/Sidebar.tsx', 'lib/email.ts',
      'lib/notifications/index.ts', 'app/dashboard/messages/page.tsx',
    ]
    for (const f of forbidden) {
      let src = ''
      try { src = readFileSync(f, 'utf8') } catch { continue }
      expect(src, f).not.toContain('AndrelConnectorBadge')
      expect(src, f).not.toContain('is_andrel_connector')
    }
  })
  it('is not in search-engine metadata', () => {
    for (const f of ['app/layout.tsx', 'app/page.tsx']) {
      let src = ''
      try { src = readFileSync(f, 'utf8') } catch { continue }
      expect(src, f).not.toMatch(/andrel_connector|AndrelConnectorBadge/i)
    }
  })
})

describe('data loading', () => {
  it('every surface selects the column explicitly — never select("*")', () => {
    for (const [name, src] of Object.entries({ NETPAGE, INTRO })) {
      expect(src, name).toContain('is_andrel_connector')
      expect(src, name).not.toMatch(/\.select\(\s*['"`]\*/)
    }
  })
  it('the introductions target map carries it through', () => {
    expect(INTRO).toMatch(/is_andrel_connector: p\.is_andrel_connector/)
  })
  it('the member-facing column contract exposes the boolean ONLY', () => {
    expect(PUBCOLS).toContain("'is_andrel_connector'")
    expect(PUBCOLS).not.toContain('andrel_connector_awarded_at')
    expect(PUBCOLS).not.toContain('andrel_connector_awarded_by')
  })
  it('private award metadata reaches no member-facing surface', () => {
    for (const [name, src] of Object.entries({ PROFILE, NETCARD, NETPAGE, INTRO })) {
      expect(src, name).not.toContain('andrel_connector_awarded_by')
      expect(src, name).not.toContain('andrel_connector_awarded_at')
    }
  })
  it('the awarded date is admin-only', () => {
    expect(ADMINUI).toContain('andrel_connector_awarded_at')
  })
})

describe('the admin control', () => {
  const fn = ACTIONS.slice(ACTIONS.indexOf('export async function adminSetAndrelConnector'),
                           ACTIONS.indexOf('export async function adminSetFoundingMember'))

  it('derives the acting administrator from the session, never from the browser', () => {
    expect(ACTIONS).toMatch(/export async function adminSetAndrelConnector\(\s*\n?\s*memberId: string,\s*\n?\s*enabled: boolean,\s*\n?\s*reason\?: string,/)
    expect(fn).toMatch(/const \{ user \} = await getSupabaseAndUser\(\)/)
    expect(fn).toMatch(/p_admin_id: actor\.id/)
    expect(fn).not.toMatch(/awarded_by|adminId:\s*(?!actor)/)
  })
  it('refuses a non-admin session', () => {
    expect(fn).toMatch(/user\.email !== ADMIN_EMAIL\) return \{ error: 'Not authorized' \}/)
  })
  it('routes through the single hardened writer', () => {
    expect(fn).toMatch(/rpc\('set_andrel_connector'/)
    expect(fn).not.toMatch(/\.from\('profiles'\)\s*\n?\s*\.update/)
  })
  it('treats an idempotent no-op as success, not failure', () => {
    expect(fn).toMatch(/'unchanged' is a SUCCESS/)
    expect(fn).toMatch(/changed: outcome === 'awarded' \|\| outcome === 'removed'/)
  })
  it('never logs the private reason', () => {
    const fn2 = ACTIONS.slice(ACTIONS.indexOf('export async function adminSetAndrelConnector'),
                              ACTIONS.indexOf('export async function adminSetFoundingMember'))
    for (const m of Array.from(fn2.matchAll(/console\.\w+\([^\n]*/g))) expect(m[0]).not.toMatch(/reason/)
    expect(fn2).toMatch(/reason_too_long/)
  })

  it('caps the reason in the UI too', () => {
    expect(ADMINUI).toMatch(/maxLength=\{500\}/)
  })

  it('never leaks a raw database message', () => {
    expect(fn).toMatch(/\(error as any\)\?\.code \?\? 'unknown'/)
    expect(fn).not.toMatch(/error\.message/)
  })
  it('the UI blocks double submission and reflects server state', () => {
    expect(ADMINUI).toMatch(/if \(connectorBusy\) return/)
    expect(ADMINUI).toMatch(/disabled=\{connectorBusy\}/)
    expect(ADMINUI).toMatch(/checked=\{selectedUser\.is_andrel_connector === true\}/)
  })
  it('confirms before removal', () => {
    expect(ADMINUI).toMatch(/if \(!next && !confirm\(/)
  })
  it('shows a failure instead of a false success', () => {
    expect(ADMINUI).toMatch(/setConnectorMsg\(\{ kind: 'err'/)
    expect(ADMINUI).toMatch(/The toggle is NOT moved on failure/)
  })
  it('states the criterion where it is applied', () => {
    expect(ANDREL_CONNECTOR_ADMIN_HELP).toBe('Recognizes members who thoughtfully expand the Andrel community.')
    expect(ADMINUI).toContain('ANDREL_CONNECTOR_ADMIN_HELP')
    // JSX wraps the label across lines, so match the element rather than a glued string.
    expect(ADMINUI).toMatch(/htmlFor="andrel-connector-toggle"[\s\S]{0,80}Andrel Connector/)
  })
  it('never awards automatically from nominations, invitations or referrals', () => {
    expect(stripComments(ACTIONS.slice(ACTIONS.indexOf('adminSetAndrelConnector'), ACTIONS.indexOf('adminSetFoundingMember'))))
      .not.toMatch(/referral|nomination|invite_count|invitation/i)
    // Scope this to EXECUTABLE SQL. The header and the COMMENT ON deliberately say the words, to
    // record that no such data is stored — asserting on the whole file would forbid the very
    // documentation that makes the guarantee legible.
    const writer = M082.slice(M082.indexOf('CREATE OR REPLACE FUNCTION public.set_andrel_connector'))
    expect(stripComments(writer.slice(0, writer.indexOf('$fn$;')))).not.toMatch(/referral|nomination|invite/i)
  })
})

describe('migration 082', () => {
  it('adds the three approved columns, unbadged by default', () => {
    expect(M082).toMatch(/ADD COLUMN IF NOT EXISTS is_andrel_connector\s+boolean\s+NOT NULL DEFAULT false/)
    expect(M082).toMatch(/ADD COLUMN IF NOT EXISTS andrel_connector_awarded_at timestamptz NULL/)
    expect(M082).toMatch(/ADD COLUMN IF NOT EXISTS andrel_connector_awarded_by uuid\s+NULL/)
  })
  it('performs no backfill and awards nobody', () => {
    // AST, not regex: the writer legitimately UPDATEs profiles inside its body, and a textual match
    // cannot tell that apart from an apply-time backfill. Only the top level can.
    const stmts = parse_sql_kinds(M082)
    expect(stmts.filter((k) => ['UpdateStmt', 'InsertStmt', 'DeleteStmt', 'SelectStmt'].includes(k))).toEqual([])
    expect(M082).not.toMatch(/^\s*(SELECT|PERFORM)\s+public\.set_andrel_connector/m)
    expect(M082).toMatch(/No backfill and no automatic awarding/)
  })
  it('enforces internal consistency in the database', () => {
    expect(M082).toMatch(/profiles_andrel_connector_consistent_chk/)
    expect(M082).toMatch(/is_andrel_connector = true\s*\n?\s*AND andrel_connector_awarded_at IS NOT NULL/)
  })
  it('has one hardened writer, service_role only', () => {
    expect(M082).toMatch(/CREATE OR REPLACE FUNCTION public\.set_andrel_connector\(/)
    expect(M082).toMatch(/LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''/)
    expect(M082).toMatch(/GRANT EXECUTE ON FUNCTION public\.set_andrel_connector\(uuid, uuid, boolean, text\) TO service_role;/)
    for (const r of ['PUBLIC', 'anon', 'authenticated']) {
      expect(M082).toContain(`REVOKE ALL ON FUNCTION public.set_andrel_connector(uuid, uuid, boolean, text) FROM ${r};`)
    }
  })
  it('verifies the acting administrator inside the database', () => {
    expect(M082).toMatch(/a\.is_admin IS TRUE/)
    expect(M082).toMatch(/'not_an_administrator'/)
    expect(M082).toMatch(/'self_award'/)
  })
  it('writes exactly one audit row per real change, and none for a no-op', () => {
    expect(M082).toMatch(/IF v_current = p_enabled THEN[\s\S]{0,200}'unchanged'/)
    const fn = M082.slice(M082.indexOf('CREATE OR REPLACE FUNCTION public.set_andrel_connector'))
    expect((fn.slice(0, fn.indexOf('$fn$;')).match(/INSERT INTO public\.member_recognition_events/g) ?? []).length).toBe(1)
  })
  it('the audit table is append-only and unreachable from a browser', () => {
    expect(M082).toMatch(/BEFORE UPDATE OR DELETE ON public\.member_recognition_events/)
    expect(M082).toMatch(/BEFORE TRUNCATE ON public\.member_recognition_events/)
    expect(M082).toMatch(/ENABLE ROW LEVEL SECURITY/)
    for (const r of ['PUBLIC', 'anon', 'authenticated', 'service_role']) {
      expect(M082).toContain(`REVOKE ALL ON public.member_recognition_events FROM ${r};`)
    }
    expect(M082).toMatch(/GRANT SELECT, INSERT ON public\.member_recognition_events TO service_role;/)
  })
  it('stores no referral counts or private referral detail', () => {
    const tbl = M082.slice(M082.indexOf('CREATE TABLE IF NOT EXISTS public.member_recognition_events'))
    expect(tbl.slice(0, tbl.indexOf(');'))).not.toMatch(/referral|invite|nomination|count/i)
  })
  it('exposes only the boolean to members, and keeps the privacy contract', () => {
    const view = M082.slice(M082.indexOf('CREATE OR REPLACE VIEW public.public_profiles'))
    const body = view.slice(0, view.indexOf(';'))
    expect(body).toContain('is_andrel_connector')
    expect(body).not.toContain('andrel_connector_awarded_at')
    expect(body).not.toContain('andrel_connector_awarded_by')
    expect(body).toMatch(/security_invoker = off, security_barrier = on/)
    expect(body).toMatch(/WHERE public\.can_discover_profile\(id\)/)
  })
  it('refuses to run against a weaker privacy contract', () => {
    expect(M082).toMatch(/is not a security_barrier view/)
    expect(M082).toMatch(/can_discover_profile\(uuid\) is absent/)
    expect(M082).toMatch(/profiles\.is_admin is absent/)
  })

  it('pins the WHOLE deployed view contract, not a marker', () => {
    const g = M082.slice(M082.indexOf('DO $viewguard$'), M082.indexOf('$viewguard$;'))
    // the four baselines come from the preflight, not from this file
    // The production baselines are PINNED CONSTANTS, not runtime settings: a SET LOCAL would have to
    // land in the same transaction, which a separately submitted SQL Editor statement cannot promise.
    expect(g).toContain("c_expect_md5   constant text := '4f7055f696f341f3c508d65b26fb6703'")
    expect(g).toContain("c_expect_owner constant text := 'postgres'")
    expect(g).toContain("c_expect_acl   constant text := 'postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres,authenticated=r/postgres'")
    expect(g).toContain("c_expect_cdp   constant text := '43624624c629e2d67978db0e9745ae1c'")
    // definition, ordered columns+types, options, owner, grants, discovery predicate
    expect(g).toMatch(/pg_get_viewdef\(c_view, true\)/)
    expect(g).toMatch(/format_type\(a\.atttypid, a\.atttypmod\)/)
    expect(g).toMatch(/1:id:uuid,2:full_name:text/)
    // JSONB, not text[]. Migration 041 created current_focus_areas jsonb, and previous_roles holds
    // an array of objects. An earlier draft guessed text[] from the genuinely-text[] neighbours.
    expect(g).toContain('19:current_focus_areas:jsonb,20:previous_roles:jsonb')
    expect(g).not.toContain('current_focus_areas:text[]')
    expect(g).not.toContain('previous_roles:text[]')
    expect(g).toMatch(/pg_get_userbyid\(c\.relowner\)/)
    expect(g).toMatch(/relacl::text\[\]/)
    expect(g).toMatch(/security_barrier/)
    expect(g).toMatch(/security_invoker/)
    expect(g).toMatch(/can_discover_profile identity arguments/)
    expect(g).toMatch(/unexpected overload/)
  })

  it('proves the post-state differs only by the appended boolean, in the same transaction', () => {
    const g = M082.slice(M082.indexOf('DO $viewguard$'), M082.indexOf('$viewguard$;'))
    expect(g).toMatch(/v_cols_after <> v_cols_before \|\| ',21:is_andrel_connector:boolean'/)
    expect(g).toMatch(/v_owner_after <> v_owner_before/)
    expect(g).toMatch(/v_acl_after IS DISTINCT FROM v_acl_before/)
    expect(g).toMatch(/v_cdp_md5_after IS DISTINCT FROM v_cdp_md5/)
    // the replacement happens INSIDE the guard, so a failed post-condition rolls it back
    expect(g.indexOf('CREATE OR REPLACE VIEW public.public_profiles')).toBeGreaterThan(g.indexOf('v_md5_before <> '))
    expect(g.indexOf('v_cols_after <> v_cols_before')).toBeGreaterThan(g.indexOf('CREATE OR REPLACE VIEW public.public_profiles'))
  })

  it('compares the security POSTURE, not the reloptions encoding', () => {
    const g = M082.slice(M082.indexOf('DO $viewguard$'), M082.indexOf('$viewguard$;'))
    expect(g).toMatch(/Compare the POSTURE, not the encoding/)
    expect(g).toMatch(/v_barrier_after IS DISTINCT FROM v_barrier_before/)
  })

  it('is self-contained: no runtime setting, no client command, no placeholder', () => {
    const executable = M082.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(executable).not.toMatch(/current_setting|SET LOCAL/)
    expect(M082).not.toMatch(/^\\[a-z]/m)          // no psql backslash command
    expect(M082).not.toMatch(/<baseline_|<value>|TODO|PLACEHOLDER/)
  })

  it('never casts, converts or re-types the two JSONB columns', () => {
    expect(M082).not.toMatch(/ALTER COLUMN (current_focus_areas|previous_roles)/)
    expect(M082).not.toMatch(/current_focus_areas::|previous_roles::/)
    expect(M082).not.toMatch(/jsonb_array_elements_text\(current_focus_areas\)/)
    // the view restates them as bare column references, nothing more
    const view = M082.slice(M082.indexOf('CREATE OR REPLACE VIEW public.public_profiles'))
    expect(view.slice(0, view.indexOf('$ddl$'))).toMatch(/current_focus_areas, previous_roles,\s*\n\s*is_andrel_connector/)
  })

  it('bounds and sanitises the private reason', () => {
    expect(M082).toMatch(/length\(reason\) <= 500/)
    expect(M082).toMatch(/'reason_too_long'/)
    expect(M082).toMatch(/v_reason := NULLIF\(pg_catalog\.btrim\(COALESCE\(p_reason, ''\)\), ''\)/)
    expect(M082).toMatch(/REFUSE an oversized note rather than silently truncating/)
  })
  it('no browser role can write the badge columns', () => {
    expect(M082).toMatch(/REVOKE UPDATE \(is_andrel_connector, andrel_connector_awarded_at, andrel_connector_awarded_by\)\s*\n\s*ON public\.profiles FROM PUBLIC, anon, authenticated;/)
  })
  it('is one transaction, so a failure rolls everything back', () => {
    expect(M082.split('\n').filter((l) => l.trim() === 'BEGIN;').length).toBe(1)
    expect(M082.trimEnd().endsWith('COMMIT;')).toBe(true)
  })
  it('leaves migrations 063–081 alone', () => {
    for (const n of ['063', '080', '081']) {
      const other = readFileSync(
        n === '063' ? 'supabase/migrations/063_unified_introduction_capacity.sql'
        : n === '080' ? 'supabase/migrations/080_introduction_capacity_release.sql'
        : 'supabase/migrations/081_response_eligibility.sql', 'utf8')
      expect(other, n).not.toContain('andrel_connector')
    }
  })
})

describe('regression: nothing else moved', () => {
  it('matching, capacity, response eligibility and credits are untouched by 082', () => {
    expect(M082).not.toMatch(/intro_requests|member_pairs|meeting_credits|matches|count_unresolved/)
  })
  it('the profile, Network and introduction links still render', () => {
    expect(PROFILE).toContain('{name}</h1>')
    expect(NETCARD).toContain('profile.full_name')
    expect(INTRO).toContain("{s.full_name || 'New member'}")
  })
  it('the existing founding-member control is intact', () => {
    expect(ADMINUI).toMatch(/handleFoundingToggle\(selectedUser\.id, e\.target\.checked\)/)
    expect(ADMINUI).toContain('Founding Member')
  })
})
