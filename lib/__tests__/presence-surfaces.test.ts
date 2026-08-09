import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { planPresenceBatches } from '@/lib/presence/batch'
import { pickPresenceLabel } from '@/lib/presence/lastActive'

// jsdom is not available in this repo (env=node), so component behavior is covered via pure
// seams (planPresenceBatches, pickPresenceLabel) + structural assertions over the wiring.

describe('planPresenceBatches — dedupe + chunk visible member ids', () => {
  it('dedupes repeated ids into ONE batched request (card + modal + header share a member)', () => {
    expect(planPresenceBatches(['A', 'B', 'A', 'B', 'A'], 50)).toEqual([['A', 'B']])
  })
  it('drops falsy ids and preserves first-seen order', () => {
    expect(planPresenceBatches(['A', null, '', undefined, 'C', 'B'], 50)).toEqual([['A', 'C', 'B']])
  })
  it('chunks at the endpoint max so no request exceeds it', () => {
    const ids = Array.from({ length: 120 }, (_, i) => 'id' + i)
    const batches = planPresenceBatches(ids, 50)
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20])
  })
  it('empty / all-falsy → no requests', () => {
    expect(planPresenceBatches([], 50)).toEqual([])
    expect(planPresenceBatches([null, '', undefined], 50)).toEqual([])
  })
})

describe('PresenceProvider — one shared batched poll, not one-per-member (structural)', () => {
  const p = readFileSync('components/presence/PresenceProvider.tsx', 'utf8')
  it('batches through planPresenceBatches and the privacy-filtered route (max 50)', () => {
    expect(p).toContain('planPresenceBatches(')
    expect(p).toMatch(/MAX_IDS = 50/)
    expect(p).toMatch(/fetch\(`\/api\/presence\/label\?ids=/)
    expect(p).toContain('pickPresenceLabel(') // null → badge disappears (opt-out/offline)
  })
  it('ref-counts subscriptions so a card + modal for the same member poll once', () => {
    expect(p).toContain('counts.current')
    expect(p).toMatch(/subscribe/)
    expect(p).toMatch(/unsubscribe/)
  })
  it('polls ~60s, pauses when hidden, resumes/refreshes when visible, cleans up on unmount', () => {
    expect(p).toMatch(/POLL_MS = 60 \* 1000/)
    expect(p).toContain('setInterval(refresh, POLL_MS)')
    expect(p).toMatch(/visibilityState === 'hidden'/)     // pause
    expect(p).toContain('visibilitychange')               // resume hook
    expect(p).toContain('clearInterval(timer)')           // timer cleanup on unmount
    expect(p).toContain('clearTimeout(debounce.current)') // debounce cleanup
  })
  it('fails silently and never stores a raw timestamp', () => {
    expect(p).toMatch(/catch\s*\{/)
    expect(p).not.toMatch(/last_active_at|updated_at|toISOString|Date\.parse/)
  })
})

describe('LivePresenceBadge — delegates to the provider, standalone only without one', () => {
  const live = readFileSync('components/presence/LivePresenceBadge.tsx', 'utf8')
  it('prefers the shared provider (no duplicate poll when a provider exists)', () => {
    expect(live).toContain('usePresenceContext()')
    expect(live).toContain('usePresenceLabel(memberId)')
    expect(live).toMatch(/if \(ctx.*\) return/) // standalone effect no-ops when a provider drives updates
  })
  it('keeps a standalone poll for a lone profile page (no provider)', () => {
    expect(live).toMatch(/fetch\(`\/api\/presence\/label\?ids=/)
    expect(live).toContain('setInterval(refresh, POLL_MS)')
  })
})

describe('Network surface wiring (structural)', () => {
  const list = readFileSync('components/NetworkList.tsx', 'utf8')
  const card = readFileSync('components/NetworkCard.tsx', 'utf8')
  it('the list is wrapped in ONE PresenceProvider (cards + modal share it)', () => {
    expect(list).toContain('import { PresenceProvider }')
    expect(list).toMatch(/<PresenceProvider>[\s\S]*<\/PresenceProvider>/)
  })
  it('cards read presence from the shared map (no per-card fetch/poll)', () => {
    expect(card).toContain('usePresenceLabel(profile.id)')
    expect(card).toContain('<PresenceBadge label={presenceLabel}')
    expect(card).toContain('(profile as any).last_active_display') // seeded by the server label
    expect(card).not.toContain('/api/presence/label')             // NEVER polls presence per card
    expect(card).not.toMatch(/setInterval\(/)                     // no per-card timer
  })
  it('the card presence slot reserves height so a label appearing/disappearing never shifts layout', () => {
    expect(card).toMatch(/min-h-\[16px\][\s\S]{0,80}<PresenceBadge/)
  })
})

describe('Messages surface wiring (structural)', () => {
  const layout = readFileSync('app/dashboard/messages/layout.tsx', 'utf8')
  const listPage = readFileSync('app/dashboard/messages/page.tsx', 'utf8')
  const convPage = readFileSync('app/dashboard/messages/[conversationId]/page.tsx', 'utf8')
  it('the Messages route tree has ONE persistent PresenceProvider (survives conversation switches)', () => {
    expect(layout).toContain('PresenceProvider')
  })
  it('the conversation LIST shows presence for the OTHER participant only (batched, avatar dot + label)', () => {
    expect(listPage).toContain('usePresenceLabels(conversations.map((c) => c.otherUser?.id))')
    expect(listPage).toMatch(/presenceById\[conv\.otherUser\?\.id/)     // keyed by the other participant
    expect(listPage).toMatch(/isOnline &&[\s\S]{0,120}bg-green-500/)     // online → avatar dot
    expect(listPage).toMatch(/presence && !isOnline && <PresenceBadge/)  // recent → relative label
    expect(listPage).toMatch(/!isFormer \? presenceById/)               // never for former/deactivated members
  })
  it('the ACTIVE conversation header shows the full coarse label for the other participant', () => {
    expect(convPage).toContain('usePresenceLabel(conversation?.otherUser?.id)')
    expect(convPage).toMatch(/<PresenceBadge label=\{otherPresence/)
  })
  it('neither Messages surface exposes a raw timestamp client-side', () => {
    for (const src of [listPage, convPage, layout]) {
      expect(src).not.toMatch(/last_active_at|updated_at|toISOString\(\)/)
    }
  })
})

describe('Expanded Messages profile uses the same live badge (structural)', () => {
  const profile = readFileSync('app/dashboard/profile/[id]/page.tsx', 'utf8')
  it('renders LivePresenceBadge for the viewed member, seeded by a privacy-filtered RPC call', () => {
    expect(profile).toContain('<LivePresenceBadge memberId={params.id}')
    expect(profile).toContain("supabase.rpc('member_presence_labels', { target_ids: [params.id] })")
    expect(profile).toContain('initialLabel={presenceSeed}')
    // only a label seed reaches the client — never the raw row
    expect(profile).not.toMatch(/initialLabel=\{[^}]*last_active_at/)
  })
})

describe('coarse-label mapping still hides opt-out / offline (badge disappears)', () => {
  it("'Online now' shows; null / no-row / non-string → nothing", () => {
    expect(pickPresenceLabel({ labels: { M: 'Online now' } }, 'M')).toBe('Online now')
    expect(pickPresenceLabel({ labels: { M: 'Active 12m ago' } }, 'M')).toBe('Active 12m ago')
    expect(pickPresenceLabel({ labels: { M: null } }, 'M')).toBeNull() // opt-out / offline
    expect(pickPresenceLabel({ labels: {} }, 'M')).toBeNull()
  })
})
