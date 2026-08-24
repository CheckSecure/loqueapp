import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isAndrelConnector } from '@/lib/recognition/andrelConnector'

/**
 * Two defects: a stale admin checkbox, and a badge missing from the Network expanded profile.
 *
 * Both were state/derivation problems rather than data problems — the award had already committed
 * and the boolean was already being selected — so these tests pin the derivation.
 */
const ADMIN  = readFileSync('components/AdminMembersClient.tsx', 'utf8')
const MODAL  = readFileSync('components/network/ConnectionDetailModal.tsx', 'utf8')
const NETPAGE = readFileSync('app/dashboard/network/page.tsx', 'utf8')
const NETCARD = readFileSync('components/NetworkCard.tsx', 'utf8')
const PROFILE = readFileSync('app/dashboard/profile/[id]/page.tsx', 'utf8')
const INTRO   = readFileSync('app/dashboard/introductions/page.tsx', 'utf8')
const MSGS    = readFileSync('app/dashboard/messages/[conversationId]/page.tsx', 'utf8')

describe('the admin checkbox reads live server state, not a snapshot', () => {
  it('holds only the id — the captured Profile object is gone', () => {
    expect(ADMIN).toMatch(/const \[selectedUserId, setSelectedUserId\] = useState<string \| null>\(null\)/)
    // Scoped to the PANEL. The deactivate/reactivate/reset confirm dialogs still hold a Profile
    // snapshot, which is fine — they are transient and read only id and full_name. Widening this
    // change to them would have meant a larger diff for no defect.
    expect(ADMIN).not.toMatch(/const \[selectedUser, setSelectedUser\] = useState/)
  })

  it('derives the panel from the LIVE profiles array', () => {
    expect(ADMIN).toMatch(/const liveSelected = selectedUserId \? profiles\.find\(\(p\) => p\.id === selectedUserId\) \?\? null : null/)
  })

  it('a router refresh therefore cannot regress the state', () => {
    // the panel has no independent copy left to go stale
    expect(ADMIN).toMatch(/router\.refresh\(\)/)
    expect(ADMIN).toMatch(/discarded automatically once the refreshed row agrees/)
  })

  it('shows the confirmed result immediately, and only after the server confirms', () => {
    const fn = ADMIN.slice(ADMIN.indexOf('const handleAndrelConnectorToggle'),
                           ADMIN.indexOf('const handleFoundingToggle'))
    // the override is set AFTER the error branch returns
    expect(fn.indexOf("setConnectorMsg({ kind: 'err'")).toBeLessThan(fn.indexOf('setConnectorConfirmed({'))
    // and its values come from the server result, never from the requested `next`
    expect(fn).toMatch(/enabled: \(result as any\)\.enabled === true/)
    expect(fn).toMatch(/awardedAt: \(\(result as any\)\.awardedAt as string \| null\) \?\? null/)
    expect(fn).not.toMatch(/setConnectorConfirmed\(\{[\s\S]{0,120}enabled: next/)
  })

  it('the success message is derived from the same server result as the checkbox', () => {
    const fn = ADMIN.slice(ADMIN.indexOf('const handleAndrelConnectorToggle'),
                           ADMIN.indexOf('const handleFoundingToggle'))
    // both read result.enabled, so they cannot disagree
    expect(fn).toMatch(/text: \(result as any\)\.enabled \? 'Andrel Connector awarded\.' : 'Andrel Connector removed\.'/)
  })

  it('a failure records nothing, so the prior visual state stands', () => {
    const fn = ADMIN.slice(ADMIN.indexOf('const handleAndrelConnectorToggle'),
                           ADMIN.indexOf('const handleFoundingToggle'))
    const errBranch = fn.slice(fn.indexOf("if ('error' in result"), fn.indexOf('setConnectorConfirmed('))
    expect(errBranch).not.toMatch(/setConnectorConfirmed/)
    expect(errBranch).toMatch(/return/)
  })

  it('the override is dropped once the server row agrees', () => {
    expect(ADMIN).toMatch(/liveSelected\.is_andrel_connector !== connectorConfirmed\.enabled/)
  })

  it('the awarded date comes from the override while it applies', () => {
    expect(ADMIN).toMatch(/andrel_connector_awarded_at: connectorConfirmed!\.awardedAt/)
  })

  it('opening or closing the panel returns to authoritative server state', () => {
    const setter = ADMIN.slice(ADMIN.indexOf('const setSelectedUser = '), ADMIN.indexOf('const setSelectedUser = ') + 400)
    expect(setter).toMatch(/setConnectorConfirmed\(null\)/)
    expect(setter).toMatch(/setConnectorMsg\(null\)/)
    expect(setter).toMatch(/setConnectorReason\(''\)/)
  })

  it('the control is disabled while saving and cannot be double-submitted', () => {
    expect(ADMIN).toMatch(/if \(connectorBusy\) return/)
    expect(ADMIN).toMatch(/disabled=\{connectorBusy\}/)
  })

  it('the checkbox is bound to the derived member, not to local optimism', () => {
    expect(ADMIN).toMatch(/checked=\{selectedUser\.is_andrel_connector === true\}/)
  })

  it('refreshing the UI never re-triggers an award', () => {
    const fn = ADMIN.slice(ADMIN.indexOf('const handleAndrelConnectorToggle'),
                           ADMIN.indexOf('const handleFoundingToggle'))
    expect((fn.match(/adminSetAndrelConnector\(/g) ?? []).length).toBe(1)
  })
})

describe('every full or expanded profile shows the badge', () => {
  it('direct profile route', () => {
    expect(PROFILE).toMatch(/isAndrelConnector\(profile\) && \(/)
    expect(PROFILE).toContain('<AndrelConnectorBadge')
  })

  it('Network expanded profile (ConnectionDetailModal) — the surface that was missing it', () => {
    expect(MODAL).toMatch(/isAndrelConnector\(profile\) && \(/)
    expect(MODAL).toContain('<AndrelConnectorBadge')
    // below the name, so the heading keeps its own line
    expect(MODAL.indexOf('<AndrelConnectorBadge')).toBeGreaterThan(MODAL.indexOf('{profile.full_name || \'Connection\'}'))
  })

  it('Messages reaches the full profile through the shared href builder', () => {
    // the conversation header is a compact row; opening the profile routes to the direct page,
    // which is already badged — so Messages inherits it rather than duplicating markup.
    expect(MSGS).toMatch(/memberProfileHref/)
    expect(MSGS).not.toContain('AndrelConnectorBadge')
  })

  it('introductions featured card keeps its approved placement', () => {
    expect(INTRO).toMatch(/isAndrelConnector\(s\) && \(/)
    expect((INTRO.match(/<AndrelConnectorBadge/g) ?? []).length).toBe(1)
  })

  it('exactly ONE badge per expanded profile', () => {
    for (const [name, src] of Object.entries({ PROFILE, MODAL })) {
      expect((src.match(/<AndrelConnectorBadge/g) ?? []).length, name).toBe(1)
    }
  })

  it('every surface uses the shared component and the shared predicate', () => {
    for (const [name, src] of Object.entries({ PROFILE, MODAL, NETCARD, INTRO })) {
      expect(src, name).toMatch(/from '@\/components\/ui\/AndrelConnectorBadge'/)
      expect(src, name).toMatch(/from '@\/lib\/recognition\/andrelConnector'/)
    }
  })
})

describe('compact rows stay unbadged', () => {
  it('message bubbles, conversation lists, notifications and navigation', () => {
    for (const f of ['components/NotificationBell.tsx', 'components/MobileNav.tsx',
                     'components/Sidebar.tsx', 'components/MeetingDetailModal.tsx',
                     'components/IncomingInterestCard.tsx', 'lib/email.ts', 'app/layout.tsx']) {
      let src = ''
      try { src = readFileSync(f, 'utf8') } catch { continue }
      expect(src, f).not.toContain('AndrelConnectorBadge')
    }
  })
})

describe('data loading stays safe', () => {
  it('the Network page selects the boolean explicitly, never select(*)', () => {
    expect(NETPAGE).toContain('is_andrel_connector')
    expect(NETPAGE).not.toMatch(/\.select\(\s*['"`]\*/)
  })

  it('no surface loads the private award metadata', () => {
    for (const [name, src] of Object.entries({ PROFILE, MODAL, NETPAGE, NETCARD, INTRO, MSGS })) {
      expect(src, name).not.toContain('andrel_connector_awarded_at')
      expect(src, name).not.toContain('andrel_connector_awarded_by')
      expect(src, name).not.toContain('member_recognition_events')
    }
  })

  it('the badge is display-only — it never widens a query or a visibility check', () => {
    // the modal reads the prop it was handed; it issues no profile query of its own for the badge
    expect(MODAL).not.toMatch(/from\('profiles'\)[\s\S]{0,200}is_andrel_connector/)
    expect(PROFILE).toMatch(/can[Vv]iewerDiscoverMember|public_profiles/)
  })

  it('missing or legacy values render unbadged', () => {
    expect(isAndrelConnector({})).toBe(false)
    expect(isAndrelConnector({ is_andrel_connector: null } as any)).toBe(false)
    expect(isAndrelConnector(undefined)).toBe(false)
  })
})

describe('responsive and layout', () => {
  it('the modal badge wraps and does not crowd the name', () => {
    const block = MODAL.slice(MODAL.indexOf('{isAndrelConnector(profile)'), MODAL.indexOf('{isAndrelConnector(profile)') + 260)
    expect(block).toMatch(/flex flex-wrap/)
    expect(block).toMatch(/mt-1\.5/)
  })

  it('the badge itself stays on one line and never shrinks the name', () => {
    const badge = readFileSync('components/ui/AndrelConnectorBadge.tsx', 'utf8')
    expect(badge).toMatch(/whitespace-nowrap/)
    expect(badge).toMatch(/shrink-0/)
  })

  it('keeps the accessible description and focus behaviour', () => {
    const badge = readFileSync('components/ui/AndrelConnectorBadge.tsx', 'utf8')
    expect(badge).toMatch(/tabIndex=\{0\}/)
    expect(badge).toMatch(/aria-label=/)
    expect(badge).toMatch(/focus-visible:ring/)
  })
})

describe('regression', () => {
  it('no migration is involved — 082 and 083 are untouched by this change', () => {
    const m082 = readFileSync('supabase/migrations/082_andrel_connector.sql', 'utf8')
    const m083 = readFileSync('supabase/migrations/083_andrel_connector_notification.sql', 'utf8')
    expect(m082).toContain('set_andrel_connector')
    expect(m083).toContain('INSERT INTO public.notifications')
  })

  it('viewing a profile creates no notification and awards nothing', () => {
    for (const [name, src] of Object.entries({ PROFILE, MODAL, NETCARD })) {
      expect(src, name).not.toMatch(/set_andrel_connector|adminSetAndrelConnector|createNotificationSafe/)
    }
  })

  it('the existing panel controls and modal still work', () => {
    expect(ADMIN).toMatch(/handleFoundingToggle\(selectedUser\.id/)
    expect(ADMIN).toMatch(/handleQuickEdit\(selectedUser\.id/)
    expect(NETCARD).toContain('<ConnectionDetailModal')
    expect(MODAL).toContain('LivePresenceBadge')
  })
})
