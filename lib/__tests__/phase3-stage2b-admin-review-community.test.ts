import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { communityOf, MEMBER_TYPES } from '@/lib/community/memberType'

/**
 * PHASE 3 STAGE 2B, COMMIT 5 — the reviewer can tell which community they are approving.
 *
 * One introduction_batches record deliberately holds both communities' independently computed
 * suggestions, and approval stays ONE lifecycle over that one batch. This commit adds only what a
 * reviewer needs to understand what is in front of them: a label per recipient group and a
 * per-community count in the existing header.
 *
 * The label logic is pure, so it is tested directly rather than by rendering a server component.
 */

// The page's labelling rule, reproduced exactly as written there.
const COMMUNITY_LABEL: Record<string, string> = { professional: 'Professional', next: 'Next' }
const labelFor = (profile: any) => COMMUNITY_LABEL[communityOf(profile) ?? ''] ?? 'Unknown'

const breakdown = (recipients: any[]) => {
  const counts = new Map<string, number>()
  for (const r of recipients) {
    const l = labelFor(r)
    counts.set(l, (counts.get(l) ?? 0) + 1)
  }
  return [...MEMBER_TYPES.map((t) => COMMUNITY_LABEL[t]), 'Unknown']
    .filter((l) => (counts.get(l) ?? 0) > 0)
    .map((l) => `${counts.get(l)} ${l}`)
    .join(', ')
}

describe('community labelling', () => {
  it('a Professional recipient renders Professional', () => {
    expect(labelFor({ member_type: 'professional' })).toBe('Professional')
  })

  it('a Next recipient renders Next', () => {
    expect(labelFor({ member_type: 'next' })).toBe('Next')
  })

  it('an unknown community is NEVER silently rendered Professional', () => {
    for (const bad of [null, undefined, '', 'student', 'Professional', 'NEXT', 'professsional']) {
      expect(labelFor({ member_type: bad }), JSON.stringify(bad)).toBe('Unknown')
    }
    expect(labelFor(undefined)).toBe('Unknown')
    expect(labelFor({})).toBe('Unknown')
  })
})

describe('per-community recipient counts', () => {
  it('counts each community correctly in a mixed batch', () => {
    const recipients = [
      { member_type: 'professional' }, { member_type: 'next' }, { member_type: 'professional' },
      { member_type: 'next' }, { member_type: 'professional' },
    ]
    expect(breakdown(recipients)).toBe('3 Professional, 2 Next')
  })

  it('a Professional-only batch reads as it always did, plus one clause', () => {
    expect(breakdown([{ member_type: 'professional' }, { member_type: 'professional' }]))
      .toBe('2 Professional')
  })

  it('an unrecognised row is surfaced separately, never folded into Professional', () => {
    const recipients = [{ member_type: 'professional' }, { member_type: null }, { member_type: 'next' }]
    expect(breakdown(recipients)).toBe('1 Professional, 1 Next, 1 Unknown')
  })

  it('order is stable — Professional, Next, then Unknown', () => {
    const recipients = [{ member_type: null }, { member_type: 'next' }, { member_type: 'professional' }]
    expect(breakdown(recipients)).toBe('1 Professional, 1 Next, 1 Unknown')
  })

  it('an empty batch produces no breakdown clause at all', () => {
    expect(breakdown([])).toBe('')
  })
})

describe('the page stays minimal, and approval is untouched', () => {
  const SRC = readFileSync('app/dashboard/admin/batches/[batchId]/review/page.tsx', 'utf8')

  it('loads member_type through the shared constant, and reuses communityOf', () => {
    expect(SRC).toMatch(/import \{[^}]*communityOf[^}]*\} from '@\/lib\/community\/memberType'/)
    expect(SRC).toContain('${MEMBER_TYPE_COLUMNS}')
    // No second definition of the community rule on a rendering surface.
    expect(SRC).not.toMatch(/member_type === /)
  })

  it('renders one batch, with no tabs, split screens or per-community approval', () => {
    for (const forbidden of ['Tabs', 'tab-', 'role="tab"', 'ProfessionalBatch', 'NextBatch',
                             'approveProfessional', 'approveNext', 'splitBatch']) {
      expect(SRC, forbidden).not.toContain(forbidden)
    }
    // The single existing approval control is unchanged.
    expect(SRC).toContain('<BatchActionsBar batchId={params.batchId} droppedCount={totalDropped} />')
    expect(SRC.match(/<BatchActionsBar/g)).toHaveLength(1)
  })

  it('changes no data loading, grouping or ordering', () => {
    expect(SRC).toContain(".eq('batch_id', params.batchId)")
    expect(SRC).toContain("const grouped = new Map<string, any[]>()")
    expect(SRC).toMatch(/recipientIds\.sort\(\(a, b\) => \{/)
    expect(SRC).toContain('const totalGenerated = suggestions.filter')
  })

  it('does not widen the public profile surface for an admin-only page', () => {
    expect(readFileSync('lib/profiles/publicProfile.ts', 'utf8')).not.toContain('member_type')
  })

  it('adds no mentorship or recruiting concept to the review experience', () => {
    expect(SRC).not.toMatch(/mentor|recruit|bridge/i)
  })
})

describe('approval semantics were not touched by Stage 2B', () => {
  const APPROVE = readFileSync('app/api/admin/approve-batch/route.ts', 'utf8')

  it('still one lifecycle: complete the active batch, activate this one, materialise pairs', () => {
    expect(APPROVE).toContain("update({ status: 'completed' }).eq('status', 'active')")
    expect(APPROVE).toContain("update({ status: 'active' }).eq('id', batchId)")
    expect(APPROVE).toContain('materializeAdminPair(adminClient, {')
  })

  it('approval knows nothing about community — Stage 1 remains the write-time authority', () => {
    expect(APPROVE).not.toMatch(/member_type|communityOf|sameCommunity|partitionByCommunity/)
  })
})
