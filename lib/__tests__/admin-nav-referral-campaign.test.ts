import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Navigation guard: the admin dashboard must surface an entry point to the
 * Referral Campaign page. The page shipped but had no entry point; this locks in
 * the link so it can't silently disappear. Source-level assertions (the admin
 * page is a JSX server component this vitest setup can't render).
 *
 * The dashboard redesign replaced the large nav CARDS with a compact nav-LINK row,
 * so these assert the durable contract (href + label + reused lucide icon) rather
 * than the old big-card markup.
 */
const adminPage = readFileSync('app/dashboard/admin/page.tsx', 'utf8')

describe('admin dashboard — Referral Campaign entry point', () => {
  it('links to /dashboard/admin/referral-campaign', () => {
    expect(adminPage).toContain('/dashboard/admin/referral-campaign')
  })

  it('labels the link "Referral Campaign"', () => {
    expect(adminPage).toContain('Referral Campaign')
  })

  it('reuses an already-imported lucide icon (no new icon package)', () => {
    expect(adminPage).toMatch(/import \{[^}]*\bNetwork\b[^}]*\} from 'lucide-react'/)
    // The Network icon travels with the referral-campaign nav entry.
    expect(adminPage).toMatch(/referral-campaign[\s\S]{0,200}Network|Network[\s\S]{0,200}referral-campaign/)
  })

  it('inherits the page’s existing operator gate (no new permission logic)', () => {
    expect(adminPage).toContain("user.email !== ADMIN_EMAIL")
  })
})
