import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { assertUrlAllowed, ipLiteralIsPublic, fetchText } from '@/lib/company/enrichment/http'

describe('assertUrlAllowed — SSRF URL gate', () => {
  const reject = (url: string, reason?: string) => {
    const r = assertUrlAllowed(url)
    expect(r.ok, url).toBe(false)
    if (reason && !r.ok) expect(r.reason).toBe(reason)
  }
  it('rejects localhost + loopback', () => {
    reject('http://localhost', 'localhost')
    reject('http://foo.localhost', 'localhost')
    reject('http://127.0.0.1', 'non_public_ip')
    reject('http://127.5.5.5', 'non_public_ip')
    reject('http://[::1]', 'non_public_ip')
  })
  it('rejects the cloud metadata + link-local + private + CGNAT ranges', () => {
    reject('http://169.254.169.254', 'non_public_ip')
    reject('http://10.0.0.7', 'non_public_ip')
    reject('http://172.16.4.4', 'non_public_ip')
    reject('http://192.168.1.1', 'non_public_ip')
    reject('http://100.64.0.1', 'non_public_ip')
    reject('http://224.0.0.1', 'non_public_ip')
    reject('http://255.255.255.255', 'non_public_ip')
  })
  it('rejects IPv6 private / loopback / mapped-private', () => {
    reject('http://[fe80::1]', 'non_public_ip')
    reject('http://[fd00::1]', 'non_public_ip')
    reject('http://[::ffff:127.0.0.1]', 'non_public_ip')
  })
  it('rejects unsupported schemes, embedded credentials, over-long URLs', () => {
    reject('ftp://example.com', 'bad_scheme')
    reject('file:///etc/passwd', 'bad_scheme')
    reject('gopher://example.com', 'bad_scheme')
    reject('https://user:pass@example.com', 'embedded_credentials')
    reject('https://example.com/' + 'a'.repeat(3000), 'url_too_long')
  })
  it('allows a normal public HTTPS host', () => {
    const r = assertUrlAllowed('https://www.fedex.com/about')
    expect(r.ok).toBe(true)
  })
  it('ipLiteralIsPublic classifies literals; null for names', () => {
    expect(ipLiteralIsPublic('8.8.8.8')).toBe(true)
    expect(ipLiteralIsPublic('10.0.0.1')).toBe(false)
    expect(ipLiteralIsPublic('example.com')).toBeNull()
    expect(ipLiteralIsPublic('2001:4860:4860::8888')).toBe(true)
    expect(ipLiteralIsPublic('::1')).toBe(false)
  })
})

describe('fetchText — validates every hop (DNS + redirects)', () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]
  const res = (status: number, headers: Record<string, string>, body?: string): any => ({
    status, ok: status >= 200 && status < 300, url: 'https://acme-corp.com',
    headers: new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    body: body === undefined ? { cancel: async () => {} } : undefined,
    arrayBuffer: async () => new TextEncoder().encode(body || '').buffer,
  })
  let fetchMock: any
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('blocks an IP-literal target BEFORE any network call', async () => {
    const r = await fetchText('http://169.254.169.254/latest/meta-data', 3000, 100000, { lookup: publicLookup })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('blocked:non_public_ip')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks a private IPv4 and IPv6 loopback target', async () => {
    expect((await fetchText('http://10.1.2.3', 3000, 1000, { lookup: publicLookup })).error).toBe('blocked:non_public_ip')
    expect((await fetchText('http://[::1]', 3000, 1000, { lookup: publicLookup })).error).toBe('blocked:non_public_ip')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a public URL that REDIRECTS to a private address', async () => {
    fetchMock.mockResolvedValueOnce(res(302, { location: 'http://127.0.0.1/' }))
    const r = await fetchText('https://acme-corp.com', 4000, 100000, { lookup: publicLookup })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('blocked:non_public_ip')
    expect(fetchMock).toHaveBeenCalledTimes(1) // never fetched the private hop
  })

  it('rejects a candidate that resolves to a non-public address (DNS)', async () => {
    const privateLookup = async () => [{ address: '10.0.0.5', family: 4 }]
    const r = await fetchText('https://rebind.example', 4000, 100000, { lookup: privateLookup })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('blocked:resolves_non_public')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches a valid public HTTPS site (bounded HTML)', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { 'content-type': 'text/html' }, '<title>Acme</title>'))
    const r = await fetchText('https://acme-corp.com', 4000, 100000, { lookup: publicLookup })
    expect(r.ok).toBe(true)
    expect(r.text).toContain('Acme')
  })

  it('rejects a non-text content type (no arbitrary binary during discovery)', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { 'content-type': 'application/octet-stream' }, 'BINARY'))
    const r = await fetchText('https://acme-corp.com', 4000, 100000, { lookup: publicLookup })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('unacceptable_content_type')
  })

  it('rejects an oversized body via content-length', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { 'content-type': 'text/html', 'content-length': '99999999' }, 'x'))
    const r = await fetchText('https://acme-corp.com', 4000, 1000, { lookup: publicLookup })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('too_large')
  })
})
