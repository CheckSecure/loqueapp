import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Navigation guard: the admin dashboard must surface a card linking to the
 * Referral Campaign page. The page shipped but had no entry point; this locks in
 * the card so it can't silently disappear. Source-level assertions (the admin
 * page is a JSX server component this vitest setup can't render).
 */
const adminPage = readFileSync('app/dashboard/admin/page.tsx', 'utf8')

describe('admin dashboard — Referral Campaign card', () => {
  it('links to /dashboard/admin/referral-campaign', () => {
    expect(adminPage).toContain('href="/dashboard/admin/referral-campaign"')
  })

  it('uses the required title and description', () => {
    expect(adminPage).toContain('Referral Campaign')
    expect(adminPage).toContain('Invite active members to recommend high-quality additions to Andrel.')
  })

  it('reuses an already-imported lucide icon (no new icon package)', () => {
    // Card renders <Network/>, imported from the existing lucide-react import line.
    expect(adminPage).toMatch(/referral-campaign[\s\S]{0,400}<Network className=\{iconCls\}/)
    expect(adminPage).toMatch(/import \{[^}]*\bNetwork\b[^}]*\} from 'lucide-react'/)
  })

  it('is a plain Link card that inherits the page’s existing operator gate (no new permission logic)', () => {
    expect(adminPage).toMatch(/href="\/dashboard\/admin\/referral-campaign"[\s\S]{0,60}navCardBase/)
  })
})
