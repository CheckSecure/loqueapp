import { describe, it, expect } from 'vitest'
import { checkEmailSanity } from '../waitlist/emailSanity'

describe('checkEmailSanity', () => {
  it('flags the real case that nearly shipped', () => {
    const r = checkEmailSanity('verobinson@gmail.con')
    expect(r.suspect).toBe(true)
    expect(r.suggestion).toBe('verobinson@gmail.com')
  })

  it('catches near-miss provider domains', () => {
    expect(checkEmailSanity('a@gmial.com').suggestion).toBe('a@gmail.com')
    expect(checkEmailSanity('a@gmai.com').suggestion).toBe('a@gmail.com')
    expect(checkEmailSanity('a@outlok.com').suggestion).toBe('a@outlook.com')
    expect(checkEmailSanity('a@yaho.com').suggestion).toBe('a@yahoo.com')
  })

  it('catches malformed shapes', () => {
    for (const bad of ['', 'nodomain', 'a@', '@b.com', 'a b@c.com', 'a@b..com', 'a@.com', 'a@b.']) {
      expect(checkEmailSanity(bad).suspect, bad).toBe(true)
    }
  })

  it('does NOT flag legitimate corporate addresses', () => {
    // The 257-row dry run was full of these; a false positive here blocks a real invitation.
    for (const ok of [
      'someone@tiktok.com', 'someone@gm.com', 'someone@fanniemae.com',
      'a.b@skadden.com', 'a@kirkland.com', 'a@sullcrom.com',
      'first.last@sub.department.example.co.uk', 'a@company.io', 'a@firm.law',
      'a@agency.gov', 'a@school.edu', 'a+tag@startup.ai',
    ]) {
      expect(checkEmailSanity(ok).suspect, ok).toBe(false)
    }
  })

  it('does NOT flag the major providers themselves', () => {
    for (const ok of ['a@gmail.com', 'a@outlook.com', 'a@icloud.com', 'a@me.com', 'a@proton.me']) {
      expect(checkEmailSanity(ok).suspect, ok).toBe(false)
    }
  })

  it('never rewrites an address — it only ever suggests', () => {
    const src = require('node:fs').readFileSync('lib/waitlist/emailSanity.ts', 'utf8')
    expect(src).toContain('NEVER applied automatically')
    // The checker returns a verdict; it must not expose a "fix" that a caller could apply blindly.
    expect(src).not.toMatch(/export function (fix|correct|normalize)Email/)
  })
})
