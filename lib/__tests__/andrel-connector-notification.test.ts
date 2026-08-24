import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { getNotificationRoute } from '@/lib/notifications'

/**
 * The award notification.
 *
 * The DATABASE is the producer: public.set_andrel_connector (migration 083) inserts it inside the
 * award transaction, so exact-once, atomicity and the security posture are proved by
 * scripts/verify-083-andrel-connector-notification.sh against a real PostgreSQL 17 cluster. These
 * tests cover the copy, the type registration and the routing.
 */
const M083 = readFileSync('supabase/migrations/083_andrel_connector_notification.sql', 'utf8')
const M082 = readFileSync('supabase/migrations/082_andrel_connector.sql', 'utf8')
const NOTIF = readFileSync('lib/notifications/index.ts', 'utf8')
const BELL = readFileSync('components/NotificationBell.tsx', 'utf8')

const TITLE = "You've been recognized as an Andrel Connector"
const BODY  = 'Thank you for thoughtfully helping grow the Andrel community by inviting engaged professionals.'

describe('member-facing copy', () => {
  it('the database writes the approved title and body', () => {
    expect(M083).toContain("'You''ve been recognized as an Andrel Connector'")
    expect(M083).toContain(`'${BODY}'`)
  })

  it('the TypeScript copy map mirrors it exactly', () => {
    const copy = NOTIF.slice(NOTIF.indexOf('andrel_connector_awarded: {'))
    expect(copy).toContain(`title: "${TITLE}"`)
    expect(copy).toContain(`message: '${BODY}'`)
  })

  it('names no invited person and exposes no count', () => {
    expect(BODY).not.toMatch(/\b\d+\b/)
    expect(BODY.toLowerCase()).not.toMatch(/referral|invited \w+ people|members you/)
  })

  it('never says the award was automatic, and never leaks the admin reason', () => {
    expect((TITLE + BODY).toLowerCase()).not.toMatch(/automat|algorithm|threshold|qualif/)
    const fn = M083.slice(M083.indexOf('IF p_enabled THEN'), M083.indexOf('RETURN pg_catalog.jsonb_build_object'))
    expect(fn).not.toMatch(/v_reason|p_reason/)
  })

  it('uses "Andrel Connector", never "influencer" or "connecter"', () => {
    expect(TITLE).toContain('Andrel Connector')
    for (const src of [M083, NOTIF]) {
      expect(src.toLowerCase()).not.toMatch(/influencer|connecter/)
    }
  })
})

describe('the type is registered so the bell cannot fall back', () => {
  it('is in the NotificationType union', () => {
    expect(NOTIF).toMatch(/\| 'andrel_connector_awarded'/)
  })

  it('has copy, so createNotificationSafe would not reject it as unknown', () => {
    expect(NOTIF).toMatch(/andrel_connector_awarded: \{/)
  })

  it('has a link, and routes to the member’s own profile', () => {
    expect(NOTIF).toMatch(/andrel_connector_awarded: '\/dashboard\/profile'/)
    expect(getNotificationRoute('andrel_connector_awarded' as any)).toBe('/dashboard/profile')
  })

  it('is NOT left to the default route', () => {
    // The default is '/dashboard'; without an explicit case the notification would "work" while
    // going to the wrong place.
    expect(getNotificationRoute('andrel_connector_awarded' as any)).not.toBe('/dashboard')
  })

  it('the bell renders stored title/body, so no per-type UI change is needed', () => {
    expect(BELL).toMatch(/\{n\.title\}/)
    expect(BELL).toMatch(/\{n\.body\}/)
    expect(BELL).toMatch(/if \(n\.link\) window\.location\.href = n\.link/)
    expect(BELL).toMatch(/type: string/)      // not a closed union that would need widening
  })
})

describe('migration 083', () => {
  it('notifies only on a genuine award', () => {
    expect(M083).toMatch(/IF p_enabled THEN\s*\n\s*INSERT INTO public\.notifications/)
  })

  it('keys exact-once to the recognition event, using the existing convention', () => {
    expect(M083).toMatch(/RETURNING id INTO v_event_id/)
    expect(M083).toMatch(/'dedupeKey', v_event_id::text/)
    expect(M083).toMatch(/ON CONFLICT DO NOTHING/)
    expect(M083).toMatch(/notifications_user_type_dedupe_key_uniq/)
  })

  it('refuses if the dedupe index is absent — the guarantee depends on it', () => {
    expect(M083).toMatch(/refusing to rely on application-side dedupe alone/)
  })

  it('writes title, body, link and type as LITERALS the browser cannot influence', () => {
    // lastIndexOf on BOTH anchors: the file explains the mechanism in comments before performing
    // it, so the first occurrence of each string is prose, not code.
    const ins = M083.slice(M083.lastIndexOf('INSERT INTO public.notifications'),
                           M083.lastIndexOf('ON CONFLICT DO NOTHING'))
    // p_member_id IS present, and correctly so — it is the recipient, derived server-side from the
    // authenticated admin's request. What must never appear is a caller-supplied title, body, link,
    // type, dedupe key or the private reason.
    expect(ins).toContain('p_member_id')
    expect(ins).not.toMatch(/p_title|p_body|p_link|p_type|p_dedupe|p_reason|v_reason/)
    expect(ins).toContain("'/dashboard/profile'")
    expect(ins).toContain("'andrel_connector_awarded'")
  })

  it('is one transaction, so badge + audit + notification commit or roll back together', () => {
    expect(M083.split('\n').filter((l) => l.trim() === 'BEGIN;').length).toBe(1)
    expect(M083.trimEnd().endsWith('COMMIT;')).toBe(true)
    const fn = M083.slice(M083.indexOf('AS $fn$'), M083.indexOf('$fn$;'))
    expect(fn.indexOf('INSERT INTO public.member_recognition_events'))
      .toBeLessThan(fn.indexOf('INSERT INTO public.notifications'))
  })

  it('pins the post-082 writer and fails closed on drift', () => {
    const g = M083.slice(M083.indexOf('DO $drift$'), M083.indexOf('$drift$;'))
    expect(g).toContain("'2509f15ab6b2a976355fb4329bec1704'")
    expect(g).toContain('3277')
    expect(g).toMatch(/pg_catalog\.to_regprocedure\('public\.set_andrel_connector/)
    expect(g).not.toMatch(/LIMIT 1/)
    expect(g).toMatch(/v_n <> 1/)
    expect(g).toMatch(/NOT v_proc\.prosecdef/)
    expect(g).toMatch(/search_path=', 'search_path=""'/)
  })

  it('uses an unambiguous already-applied marker', () => {
    // 'andrel_connector_awarded' is a SUBSTRING of the columns andrel_connector_awarded_at/_by, so
    // using it here would have refused a fresh, un-applied database.
    const g = M083.slice(M083.indexOf('DO $drift$'), M083.indexOf('$drift$;'))
    expect(g).toContain("strpos(p.prosrc, 'INSERT INTO public.notifications')")
    expect(g).not.toMatch(/strpos\(p\.prosrc, 'andrel_connector_awarded'\)/)
  })

  it('preserves the 082 behaviour it wraps', () => {
    for (const marker of ["'not_an_administrator'", "'self_award'", "'unchanged'", "'reason_too_long'",
                          'FOR UPDATE', 'length(v_reason) > 500']) {
      expect(M083).toContain(marker)
    }
  })

  it('includes the NARROW privilege correction, and only that', () => {
    // REVOKE ALL, then grant back exactly the two abilities the bell needs. Revoking individual
    // verbs would leave column-level grants behind — PostgreSQL treats those separately.
    for (const r of ['PUBLIC', 'anon', 'authenticated']) {
      expect(M083).toContain(`REVOKE ALL ON public.notifications FROM ${r};`)
    }
    expect(M083).toMatch(/GRANT SELECT ON public\.notifications TO authenticated;/)
    expect(M083).toMatch(/GRANT UPDATE \(read_at\) ON public\.notifications TO authenticated;/)
    // exactly two grants back — nothing new is handed to a browser role
    expect((M083.match(/GRANT [^\n]*ON public\.notifications TO authenticated/g) ?? []).length).toBe(2)
    // service_role is never revoked from, and no policy is created or dropped
    expect(M083).not.toMatch(/REVOKE[^\n]*public\.notifications[^\n]*service_role/)
    expect(M083).not.toMatch(/DROP POLICY|CREATE POLICY/)
  })

  it('refuses a posture it was not audited against', () => {
    const g = M083.slice(M083.indexOf('DO $drift$'), M083.indexOf('$drift$;'))
    expect(g).toMatch(/COLUMN-level grant on public\.notifications outside read_at/)
    expect(g).toMatch(/carries a trigger/)
  })

  it('post-conditions the final posture column by column', () => {
    const a = M083.slice(M083.indexOf('DO $acl$'), M083.indexOf('$acl$;'))
    expect(a).toMatch(/anon still holds % on public\.notifications/)
    expect(a).toMatch(/PUBLIC still holds a privilege/)
    expect(a).toMatch(/authenticated can still UPDATE column %/)
    expect(a).toMatch(/authenticated can still INSERT column %/)
    expect(a).toMatch(/service_role lost %/)
    expect(a).toMatch(/member SELECT policy is missing/)
    expect(a).toMatch(/member UPDATE policy is missing/)
  })

  it('refuses rather than deleting a browser INSERT policy somebody created', () => {
    const g = M083.slice(M083.indexOf('DO $drift$'), M083.indexOf('$drift$;'))
    expect(g).toMatch(/cmd IN \('INSERT','ALL'\)/)
    // The message is split across two SQL string literals, so it is not contiguous in the file.
    expect(g).toMatch(/browser-applicable INSERT or ALL policy exists/)
    expect(g).toMatch(/remove it automatically/)
  })

  it('refuses if RLS is off, or if service_role would lose what the writers need', () => {
    const g = M083.slice(M083.indexOf('DO $drift$'), M083.indexOf('$drift$;'))
    expect(g).toMatch(/row level security is not enabled/)
    expect(g).toMatch(/service_role lacks SELECT\/INSERT\/UPDATE/)
  })

  it('post-conditions keep the bell working', () => {
    const a = M083.slice(M083.indexOf('DO $acl$'), M083.indexOf('$acl$;'))
    expect(a).toMatch(/lost SELECT - the bell would stop rendering/)
    expect(a).toMatch(/lost UPDATE\(read_at\) - mark-as-read would stop working/)
  })

  it('backfills nothing and notifies nobody during apply', () => {
    const outside = M083.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
    expect(outside).not.toMatch(/INSERT INTO|UPDATE public|DELETE FROM/)
    expect(M083).toMatch(/No backfill/)
  })

  it('leaves migration 082 untouched', () => {
    expect(M082).not.toMatch(/INSERT INTO public\.notifications/)
    expect(M082).not.toMatch(/andrel_connector_awarded'/)
  })
})

describe('the notification stays out of the surfaces it must not reach', () => {
  it('no email template mentions it', () => {
    expect(readFileSync('lib/email.ts', 'utf8')).not.toMatch(/andrel_connector_awarded|Andrel Connector/)
  })
  it('navigation and public metadata do not', () => {
    for (const f of ['components/MobileNav.tsx', 'components/Sidebar.tsx', 'app/layout.tsx']) {
      let src = ''
      try { src = readFileSync(f, 'utf8') } catch { continue }
      expect(src, f).not.toMatch(/andrel_connector_awarded/)
    }
  })
})
