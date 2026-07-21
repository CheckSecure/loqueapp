import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  pages: {} as Record<string, any>, // host → fetchText result (for validation)
  searchResults: [] as string[],    // URLs the search API returns
}))

vi.mock('@/lib/company/enrichment/http', () => ({
  fetchText: async (url: string) => {
    let host = ''
    try { host = new URL(url).hostname.replace(/^www\./, '') } catch { /* */ }
    return state.pages[host] || { ok: false, status: 404, url, contentType: '', text: '', error: undefined }
  },
  fetchBinary: async () => ({ ok: false, status: 0, url: '', contentType: '', bytes: null }),
}))

import { RegistryDiscovery, SearchWebsiteDiscovery, CompositeDiscovery } from '@/lib/company/enrichment/discovery'

beforeEach(() => {
  state.pages = {}
  state.searchResults = []
  delete process.env.SEARCH_API_KEY
  // Mock the search API (Brave-shaped JSON). fetchText is mocked separately.
  vi.stubGlobal('fetch', async () => ({
    ok: true, status: 200,
    json: async () => ({ web: { results: state.searchResults.map((u) => ({ url: u })) } }),
  }))
})

describe('layered discovery: registry → search → not_found', () => {
  it('registry hit resolves without touching search', async () => {
    const d = new CompositeDiscovery([new RegistryDiscovery(), new SearchWebsiteDiscovery()])
    const r = await d.discover('BD')
    expect(r.via).toBe('registry')
    expect(r.domain).toBe('bd.com')
  })

  it('unknown company with NO search key → not_found (never guesses a domain)', async () => {
    const d = new CompositeDiscovery([new RegistryDiscovery(), new SearchWebsiteDiscovery()])
    const r = await d.discover('Totally Unknown Startup')
    expect(r).toEqual({ website: null, domain: null, via: 'none' })
  })

  it('SearchWebsiteDiscovery is disabled without a key', () => {
    expect(new SearchWebsiteDiscovery().isEnabled()).toBe(false)
  })

  it('with a key: returns a VALIDATED result and skips a parked domain', async () => {
    process.env.SEARCH_API_KEY = 'test-key'
    state.searchResults = ['https://acmerobotics.co', 'https://acmerobotics.com/about']
    state.pages['acmerobotics.co'] = { ok: true, status: 200, url: 'https://acmerobotics.co', contentType: 'text/html', text: 'this domain is for sale', error: undefined }
    state.pages['acmerobotics.com'] = { ok: true, status: 200, url: 'https://acmerobotics.com', contentType: 'text/html', text: '<title>Acme Robotics — Industrial Automation</title>', error: undefined }
    const r = await new SearchWebsiteDiscovery().discover('Acme Robotics')
    expect(r.via).toBe('search')
    expect(r.domain).toBe('acmerobotics.com')
  })

  it('with a key: search yielding only parked/excluded hosts → not_found', async () => {
    process.env.SEARCH_API_KEY = 'test-key'
    state.searchResults = ['https://www.linkedin.com/company/x', 'https://foo.co']
    state.pages['foo.co'] = { ok: true, status: 200, url: 'https://foo.co', contentType: 'text/html', text: 'buy this domain', error: undefined }
    const r = await new SearchWebsiteDiscovery().discover('Foo Industries')
    expect(r.website).toBeNull()
  })

  it('with a key: a candidate that 301s to a marketplace host is rejected', async () => {
    process.env.SEARCH_API_KEY = 'test-key'
    state.searchResults = ['https://widgets.com']
    // Page loads but its final URL is a marketplace (redirect).
    state.pages['widgets.com'] = { ok: true, status: 200, url: 'https://www.afternic.com/forsale/widgets.com', contentType: 'text/html', text: '<title>Widgets</title>', error: undefined }
    const r = await new SearchWebsiteDiscovery().discover('Widgets')
    expect(r.website).toBeNull()
  })
})
