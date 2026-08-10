import { describe, it, expect } from 'vitest'
import { dashboardRedirect } from '@/lib/auth/dashboardGate'

// Routing decisions behind the /dashboard middleware. Legacy temp-password enforcement is
// PRESERVED (flagged accounts are forced to reset); once a password is set the flag is cleared
// (elsewhere) so a normal login is never looped back to "Set your password".

const HOME = '/dashboard/introductions'

describe('dashboardRedirect — legacy enforcement + onboarding routing', () => {
  // Scenario: LEGACY temporary-password login that has NOT completed a secure reset → still forced.
  it('a still-flagged account is forced to the reset form (enforcement preserved)', () => {
    expect(dashboardRedirect({ password_reset_required: true, email_verified: true, profile_complete: false }, HOME))
      .toBe('/dashboard/reset-password')
    // even an already-onboarded legacy account is forced to set a real password:
    expect(dashboardRedirect({ password_reset_required: true, email_verified: true, profile_complete: true }, HOME))
      .toBe('/dashboard/reset-password')
  })
  it('a flagged account is not bounced off the reset form itself (no loop while setting it)', () => {
    expect(dashboardRedirect({ password_reset_required: true, email_verified: true, profile_complete: false }, '/dashboard/reset-password'))
      .toBeNull()
  })

  // Scenario: secure invite with password_reset_required=true, AFTER the flag is cleared on set.
  it('once the flag is cleared, a verified-but-incomplete user proceeds to ONBOARDING (not reset)', () => {
    expect(dashboardRedirect({ password_reset_required: false, email_verified: true, profile_complete: false }, HOME))
      .toBe('/dashboard/onboarding')
  })

  // Scenario: secure invite with NO profile row.
  it('a fresh invitee with NO profile row proceeds to onboarding, never the legacy form', () => {
    expect(dashboardRedirect(null, HOME)).toBe('/dashboard/onboarding')
    expect(dashboardRedirect(undefined, HOME)).toBe('/dashboard/onboarding')
  })
  it('a no-profile user is not bounced off the onboarding page', () => {
    expect(dashboardRedirect(null, '/dashboard/onboarding')).toBeNull()
  })

  // Scenario: established-user password recovery (flag already/now false, profile complete).
  it('an established, onboarded user (flag clear) reaches the dashboard — no redirect', () => {
    const p = { password_reset_required: false, email_verified: true, profile_complete: true }
    expect(dashboardRedirect(p, HOME)).toBeNull()
    expect(dashboardRedirect(p, '/dashboard/settings')).toBeNull()
  })

  // Scenario: logout/login after successful setup — never returns to Set Your Password.
  it('regression: after a successful password set (flag cleared), re-login never returns to reset', () => {
    const incomplete = { password_reset_required: false, email_verified: true, profile_complete: false }
    const complete = { password_reset_required: false, email_verified: true, profile_complete: true }
    expect(dashboardRedirect(incomplete, HOME)).toBe('/dashboard/onboarding')
    expect(dashboardRedirect(complete, HOME)).toBeNull()
    expect(dashboardRedirect(incomplete, HOME)).not.toBe('/dashboard/reset-password')
    expect(dashboardRedirect(complete, HOME)).not.toBe('/dashboard/reset-password')
  })
})
