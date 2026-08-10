import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Structural guarantees for the secure /auth/reset-password client (vitest runs in node). The
// browser must NOT perform the password update or clear the flag itself — both happen server-side.

const src = readFileSync('app/auth/reset-password/page.tsx', 'utf8')

describe('/auth/reset-password — no client-side password mutation or flag clear', () => {
  it('the browser never calls auth.updateUser (the server route does)', () => {
    expect(src).not.toMatch(/\.updateUser\(/)
  })
  it('the browser never updates the profiles table (no client-side flag clear)', () => {
    expect(src).not.toMatch(/from\(['"]profiles['"]\)/)
  })
  it('submits to the server route POST /api/auth/complete-reset', () => {
    expect(src).toContain('/api/auth/complete-reset')
    expect(src).toMatch(/mode:\s*'set'/)
    expect(src).toMatch(/mode:\s*'finalize'/)
  })
})

describe('/auth/reset-password — sessionStorage marker is DISPLAY-ONLY (not authority)', () => {
  it('the marker only chooses whether to resume finalization on mount — the server re-authorizes', () => {
    // On mount the marker gates the DISPLAY (runFinalize vs form); runFinalize hits the server route,
    // which rejects without a valid continuation cookie. The marker itself clears nothing.
    expect(src).toMatch(/if \(isPwSet\(\)\) runFinalize\(\)/)
    // and runFinalize authorizes via the server, not the marker:
    const runFinalize = src.slice(src.indexOf('const runFinalize'), src.indexOf('useEffect('))
    expect(runFinalize).toContain("mode: 'finalize'")
    expect(runFinalize).not.toMatch(/from\(['"]profiles['"]\)/)
    expect(runFinalize).not.toMatch(/\.updateUser\(/)
  })
})

describe('/auth/reset-password — form visibility + finalize-only retry', () => {
  it('the password form renders ONLY for the ready/submitting phases', () => {
    expect(src).toMatch(/\(phase === 'ready' \|\| phase === 'submitting'\)/)
  })
  it('on server "finalize" stage the form is not shown again; only finalization is retried', () => {
    const errBlock = src.slice(src.indexOf("phase === 'finalize_error'"), src.indexOf('{/* Success */}', src.indexOf("phase === 'finalize_error'")))
    expect(errBlock).toMatch(/onClick=\{\(\) => \{ runFinalize\(\) \}\}/)
    expect(errBlock).not.toMatch(/\.updateUser\(/)
    expect(errBlock).not.toContain('handleReset')
    expect(errBlock).toContain('/login') // safe alternate path
    expect(src).toContain('we couldn’t finish preparing your account')
  })
})

describe('completeOnboarding — clears the legacy flag (defense in depth)', () => {
  const actions = readFileSync('app/actions.ts', 'utf8')
  const onboarding = actions.slice(
    actions.indexOf('export async function completeOnboarding'),
    actions.indexOf('export async function saveAvatarUrl'),
  )
  it('the onboarding upsert sets password_reset_required: false', () => {
    expect(onboarding).toMatch(/password_reset_required:\s*false/)
    expect(onboarding).toMatch(/profile_complete:\s*true/)
  })
})
