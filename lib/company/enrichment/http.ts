import { lookup as dnsLookup } from 'node:dns/promises'

/**
 * SSRF-hardened, bounded HTTP for the enrichment pipeline.
 *
 * Every fetch here targets a URL that may originate from search results or from
 * scraped homepage HTML (og:image, favicon, redirects) — i.e. attacker-
 * influenceable. So we:
 *   - allow only http/https, reject embedded credentials, cap URL/host length;
 *   - reject localhost, loopback, private/link-local/CGNAT/multicast/reserved
 *     IPv4, and IPv6 loopback/link-local/ULA/mapped-private (incl. the cloud
 *     metadata address 169.254.169.254);
 *   - resolve DNS and reject if ANY resolved address is non-public;
 *   - follow redirects MANUALLY, re-validating every hop (not just the first);
 *   - bound redirect count, total duration, and response body size;
 *   - accept only text/HTML (or images for logos) — never arbitrary binaries.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const MAX_URL_LEN = 2048
const MAX_HOST_LEN = 253
const MAX_REDIRECTS = 4

// ───────────────────────── IP classification ─────────────────────────
function parseIpv4(s: string): [number, number, number, number] | null {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return null
  const o = m.slice(1, 5).map(Number) as [number, number, number, number]
  return o.every((n) => n >= 0 && n <= 255) ? o : null
}
function ipv4IsPublic(a: number, b: number, _c: number, _d: number): boolean {
  if (a === 0) return false                         // 0.0.0.0/8 "this network"
  if (a === 10) return false                        // 10/8 private
  if (a === 127) return false                       // loopback
  if (a === 169 && b === 254) return false          // link-local (incl. metadata)
  if (a === 172 && b >= 16 && b <= 31) return false // 172.16/12 private
  if (a === 192 && b === 168) return false          // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return false// 100.64/10 CGNAT
  if (a === 192 && b === 0 && _c === 0) return false// 192.0.0/24
  if (a === 192 && b === 0 && _c === 2) return false// 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 88 && _c === 99) return false // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return false// 198.18/15 benchmark
  if (a === 198 && b === 51 && _c === 100) return false// TEST-NET-2
  if (a === 203 && b === 0 && _c === 113) return false // TEST-NET-3
  if (a >= 224) return false                        // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return true
}
function ipv6IsPublic(raw: string): boolean {
  const s = raw.toLowerCase().replace(/^\[|\]$/g, '')
  if (s === '::1' || s === '::') return false                 // loopback / unspecified
  if (/^fe[89ab]/.test(s)) return false                       // fe80::/10 link-local
  if (/^f[cd]/.test(s)) return false                          // fc00::/7 unique-local
  if (/^ff/.test(s)) return false                             // ff00::/8 multicast
  if (s.startsWith('2001:db8')) return false                  // documentation
  const mapped = s.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/) // IPv4-mapped / -compatible
  if (mapped) { const v4 = parseIpv4(mapped[1]); return v4 ? ipv4IsPublic(...v4) : false }
  const hexMapped = s.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16)
    return ipv4IsPublic((hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255)
  }
  return true
}
/** true/false if `host` is an IP literal; null if it's a name needing DNS. */
export function ipLiteralIsPublic(host: string): boolean | null {
  const h = host.replace(/^\[|\]$/g, '')
  const v4 = parseIpv4(h)
  if (v4) return ipv4IsPublic(...v4)
  if (h.includes(':')) return ipv6IsPublic(h)
  return null
}

// ───────────────────────── URL / host validation ─────────────────────────
export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string }
export function assertUrlAllowed(raw: string): UrlCheck {
  if (!raw || raw.length > MAX_URL_LEN) return { ok: false, reason: 'url_too_long' }
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, reason: 'unparseable' } }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'bad_scheme' }
  if (u.username || u.password) return { ok: false, reason: 'embedded_credentials' }
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host || host.length > MAX_HOST_LEN) return { ok: false, reason: 'bad_host' }
  if (host === 'localhost' || host.endsWith('.localhost')) return { ok: false, reason: 'localhost' }
  if (ipLiteralIsPublic(host) === false) return { ok: false, reason: 'non_public_ip' }
  return { ok: true, url: u }
}

type Lookup = (host: string, opts: { all: true }) => Promise<Array<{ address: string; family: number }>>
async function hostResolvesPublic(host: string, lookup: Lookup): Promise<{ ok: boolean; reason?: string }> {
  const clean = host.replace(/^\[|\]$/g, '')
  if (ipLiteralIsPublic(clean) !== null) return { ok: true } // literal already checked
  try {
    const addrs = await lookup(clean, { all: true })
    if (!addrs || addrs.length === 0) return { ok: false, reason: 'dns_empty' }
    for (const a of addrs) {
      if (ipLiteralIsPublic(a.address) !== true) return { ok: false, reason: 'resolves_non_public' }
    }
    return { ok: true }
  } catch { return { ok: false, reason: 'dns_error' } }
}

// ───────────────────────── bounded, redirect-validating request ─────────────────────────
type Accept = 'text' | 'binary'
type ReqOpts = { timeoutMs?: number; maxBytes?: number; maxRedirects?: number; lookup?: Lookup }

async function readBounded(res: any, maxBytes: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader?.()
  if (!reader) {
    const ab = await res.arrayBuffer()
    return ab.byteLength > maxBytes ? null : new Uint8Array(ab)
  }
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.length
      if (total > maxBytes) { try { await reader.cancel() } catch { /* */ } return null }
      chunks.push(value)
    }
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }
  return out
}

async function safeRequest(startUrl: string, accept: Accept, opts: ReqOpts) {
  const { timeoutMs = 6000, maxBytes = 1_500_000, maxRedirects = MAX_REDIRECTS, lookup = dnsLookup as unknown as Lookup } = opts
  const deadline = Date.now() + timeoutMs
  let url = startUrl
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const chk = assertUrlAllowed(url)
    if (!chk.ok) return { ok: false, status: 0, url, contentType: '', error: `blocked:${chk.reason}` }
    const dns = await hostResolvesPublic(chk.url.hostname, lookup)
    if (!dns.ok) return { ok: false, status: 0, url, contentType: '', error: `blocked:${dns.reason}` }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { ok: false, status: 0, url, contentType: '', error: 'timeout' }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), remaining)
    try {
      const res: any = await fetch(url, {
        redirect: 'manual', signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: accept === 'binary' ? 'image/*,*/*;q=0.8' : 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      })
      const status: number = res.status
      const contentType: string = res.headers.get('content-type') || ''
      if (status >= 300 && status < 400) {
        const loc = res.headers.get('location')
        try { await res.body?.cancel?.() } catch { /* */ }
        if (!loc) return { ok: false, status, url, contentType, error: 'redirect_no_location' }
        try { url = new URL(loc, url).toString() } catch { return { ok: false, status, url, contentType, error: 'bad_redirect' } }
        continue // re-validate the destination on the next loop
      }
      if (!res.ok) { try { await res.body?.cancel?.() } catch { /* */ } return { ok: false, status, url: res.url || url, contentType, error: `HTTP ${status}` } }
      const acceptable = accept === 'binary'
        ? (!contentType || /^image\//i.test(contentType))
        : (!contentType || /text\/|application\/(xhtml|xml|json)/i.test(contentType))
      if (!acceptable) { try { await res.body?.cancel?.() } catch { /* */ } return { ok: false, status, url: res.url || url, contentType, error: 'unacceptable_content_type' } }
      const len = parseInt(res.headers.get('content-length') || '', 10)
      if (Number.isFinite(len) && len > maxBytes) { try { await res.body?.cancel?.() } catch { /* */ } return { ok: false, status, url: res.url || url, contentType, error: 'too_large' } }
      const buf = await readBounded(res, maxBytes)
      if (buf === null) return { ok: false, status, url: res.url || url, contentType, error: 'too_large' }
      return { ok: true, status, url: res.url || url, contentType, buf }
    } catch (e: any) {
      return { ok: false, status: 0, url, contentType: '', error: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch_error') }
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, status: 0, url, contentType: '', error: 'too_many_redirects' }
}

// ───────────────────────── public API (unchanged signatures) ─────────────────────────
export type TextResult = { ok: boolean; status: number; url: string; contentType: string; text: string; error?: string }
export type BinaryResult = { ok: boolean; status: number; url: string; contentType: string; bytes: Uint8Array | null; error?: string }

export async function fetchText(url: string, timeoutMs = 6000, maxBytes = 1_500_000, opts: ReqOpts = {}): Promise<TextResult> {
  const r = await safeRequest(url, 'text', { ...opts, timeoutMs, maxBytes })
  if (!r.ok || !('buf' in r) || !r.buf) return { ok: false, status: r.status, url: r.url, contentType: r.contentType, text: '', error: r.error }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(r.buf.subarray(0, maxBytes))
  return { ok: true, status: r.status, url: r.url, contentType: r.contentType, text }
}

export async function fetchBinary(url: string, timeoutMs = 6000, maxBytes = 3_000_000, opts: ReqOpts = {}): Promise<BinaryResult> {
  const r = await safeRequest(url, 'binary', { ...opts, timeoutMs, maxBytes })
  if (!r.ok || !('buf' in r) || !r.buf) return { ok: false, status: r.status, url: r.url, contentType: r.contentType, bytes: null, error: r.error }
  return { ok: true, status: r.status, url: r.url, contentType: r.contentType, bytes: r.buf }
}
