import { describe, it, expect } from 'vitest'
import { buildProfileUpdate } from '@/lib/profile/updatePayload'

const fd = (entries: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.set(k, v)
  return f
}
const payloadOf = (f: FormData) => {
  const r = buildProfileUpdate(f)
  if ('error' in r) throw new Error('unexpected validation error: ' + r.error)
  return r.payload
}

describe('true partial update — omitted fields are never written', () => {
  it('an empty submission writes nothing (no nulls/empties/defaults)', () => {
    expect(payloadOf(new FormData())).toEqual({})
  })

  it('Step2 (goals/interests/intro_prefs only) cannot wipe Step1 profile fields', () => {
    const p = payloadOf(fd({ purposes: 'Hiring', interests: 'Sports', intro_preferences: 'Founders' }))
    // ONLY the three submitted fields are present…
    expect(p).toEqual({ purposes: ['Hiring'], interests: ['Sports'], intro_preferences: ['Founders'] })
    // …so none of Step1's fields can be nulled.
    for (const k of ['full_name', 'title', 'company', 'bio', 'location', 'city', 'state',
      'role_type', 'seniority', 'expertise', 'exact_job_title', 'current_status',
      'previous_roles', 'meeting_format_preference', 'geographic_scope']) {
      expect(p).not.toHaveProperty(k)
    }
  })

  it('Step1 (basic info) writes its fields and does not include goals/interests', () => {
    const p = payloadOf(fd({
      full_name: 'Jane', title: 'GC', company: 'Acme', bio: 'hi', location: 'NYC',
      role_type: 'Legal', seniority: 'Senior', expertise: 'AI,Privacy',
    }))
    expect(p).toMatchObject({
      full_name: 'Jane', title: 'GC', company: 'Acme', bio: 'hi', location: 'NYC',
      role_type: 'Legal', seniority: 'Senior', expertise: ['AI', 'Privacy'],
    })
    expect(p).not.toHaveProperty('purposes')
    expect(p).not.toHaveProperty('interests')
    expect(p).not.toHaveProperty('intro_preferences')
  })

  it('Settings save WITHOUT intro_preferences preserves it (not written)', () => {
    const p = payloadOf(fd({
      full_name: 'Jane', title: 'GC', company: 'Acme', city: 'NYC', state: 'NY',
      bio: 'hi', purposes: 'Hiring', role_type: 'Legal', seniority: 'Senior', expertise: 'AI',
    }))
    expect(p).not.toHaveProperty('intro_preferences') // ProfileEditForm omits it → never wiped
    expect(p).not.toHaveProperty('interests')          // also omitted → preserved
    expect(p.purposes).toEqual(['Hiring'])             // submitted → written
  })
})

describe('location precedence', () => {
  it('omitting location/city/state touches none of the three', () => {
    const p = payloadOf(fd({ full_name: 'Jane' }))
    expect(p).not.toHaveProperty('location')
    expect(p).not.toHaveProperty('city')
    expect(p).not.toHaveProperty('state')
  })
  it('explicit location writes location WITHOUT clearing city/state', () => {
    const p = payloadOf(fd({ location: 'San Francisco' }))
    expect(p.location).toBe('San Francisco')
    expect(p).not.toHaveProperty('city')
    expect(p).not.toHaveProperty('state')
  })
  it('submitted city + state derives location', () => {
    const p = payloadOf(fd({ city: 'San Francisco', state: 'CA' }))
    expect(p).toMatchObject({ city: 'San Francisco', state: 'CA', location: 'San Francisco, CA' })
  })
  it('explicit location wins even when city/state are also submitted', () => {
    const p = payloadOf(fd({ location: 'Remote', city: 'San Francisco', state: 'CA' }))
    expect(p.location).toBe('Remote')
    expect(p.city).toBe('San Francisco')
    expect(p.state).toBe('CA')
  })
})

describe('explicit empty values clear ONLY the submitted field', () => {
  it('empty full_name/bio clear those fields', () => {
    const p = payloadOf(fd({ full_name: '', bio: '' }))
    expect(p.full_name).toBe('')
    expect(p.bio).toBe('')
    expect(p).not.toHaveProperty('title') // untouched
  })
  it('empty city → null; empty location → null; empty current_status → null', () => {
    expect(payloadOf(fd({ city: '' })).city).toBeNull()
    expect(payloadOf(fd({ location: '' })).location).toBeNull()
    expect(payloadOf(fd({ current_status: '' })).current_status).toBeNull()
  })
})

describe('purposes/interests remain present-only (unchanged from fe9176a)', () => {
  it('written only when submitted, parsed to arrays', () => {
    expect(payloadOf(fd({ purposes: 'Hiring,Networking' })).purposes).toEqual(['Hiring', 'Networking'])
    expect(payloadOf(fd({ interests: 'Sports' })).interests).toEqual(['Sports'])
    const none = payloadOf(fd({ title: 'GC' }))
    expect(none).not.toHaveProperty('purposes')
    expect(none).not.toHaveProperty('interests')
  })
})

describe('validation for required-when-present matcher fields', () => {
  it('empty role_type / seniority / expertise return an error (not a silent clear)', () => {
    expect(buildProfileUpdate(fd({ role_type: '' }))).toEqual({ error: 'Please select your professional role' })
    expect(buildProfileUpdate(fd({ seniority: '' }))).toEqual({ error: 'Please select your seniority level' })
    expect(buildProfileUpdate(fd({ expertise: '' }))).toEqual({ error: 'Please select at least one area of expertise' })
  })
  it('omitting them is fine (present-only) — no error, not written', () => {
    const p = payloadOf(fd({ bio: 'hi' }))
    expect(p).not.toHaveProperty('role_type')
    expect(p).not.toHaveProperty('seniority')
    expect(p).not.toHaveProperty('expertise')
  })
})
