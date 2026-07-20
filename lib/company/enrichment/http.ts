/** Small timeout-bounded HTTP helpers for the enrichment pipeline. */

// A realistic desktop UA — some sites serve empty/blocked HTML to obvious bots.
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'

export type TextResult = {
  ok: boolean
  status: number
  url: string // final URL after redirects
  contentType: string
  text: string
  error?: string
}

export async function fetchText(url: string, timeoutMs = 6000, maxBytes = 1_500_000): Promise<TextResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    })
    const contentType = res.headers.get('content-type') || ''
    // Cap how much HTML we read — homepages can be huge; the head is what we need.
    const buf = await res.arrayBuffer()
    const bytes = new Uint8Array(buf).subarray(0, maxBytes)
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    return { ok: res.ok, status: res.status, url: res.url || url, contentType, text }
  } catch (e: any) {
    return { ok: false, status: 0, url, contentType: '', text: '', error: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch_error') }
  } finally {
    clearTimeout(timer)
  }
}

export type BinaryResult = {
  ok: boolean
  status: number
  url: string
  contentType: string
  bytes: Uint8Array | null
  error?: string
}

export async function fetchBinary(url: string, timeoutMs = 6000, maxBytes = 3_000_000): Promise<BinaryResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
    })
    const contentType = res.headers.get('content-type') || ''
    if (!res.ok) return { ok: false, status: res.status, url: res.url || url, contentType, bytes: null, error: `HTTP ${res.status}` }
    const buf = await res.arrayBuffer()
    if (buf.byteLength > maxBytes) return { ok: false, status: res.status, url: res.url || url, contentType, bytes: null, error: 'too_large' }
    return { ok: true, status: res.status, url: res.url || url, contentType, bytes: new Uint8Array(buf) }
  } catch (e: any) {
    return { ok: false, status: 0, url, contentType: '', bytes: null, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch_error') }
  } finally {
    clearTimeout(timer)
  }
}
