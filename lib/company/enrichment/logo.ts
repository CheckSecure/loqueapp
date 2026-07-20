import { fetchBinary } from './http'

/**
 * Download a company logo and store OUR OWN copy in the public `company-logos`
 * Supabase Storage bucket, returning the permanent public URL. We never hotlink
 * the source; logo_url always points at our bucket.
 *
 * Candidates are tried best-first; the first one that downloads as a genuine,
 * non-trivial image wins. If none qualify, returns null (logo_url stays null).
 */

export const LOGO_BUCKET = 'company-logos'
const MIN_BYTES = 200          // reject 1x1 trackers / empty responses
const MAX_BYTES = 3_000_000

type Sniffed = { ext: string; contentType: string }

/** Identify an image by magic bytes (trust content over the server's header). */
function sniff(bytes: Uint8Array, headerType: string): Sniffed | null {
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', contentType: 'image/png' }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' }
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { ext: 'gif', contentType: 'image/gif' }
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { ext: 'webp', contentType: 'image/webp' }
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return { ext: 'ico', contentType: 'image/x-icon' }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return { ext: 'bmp', contentType: 'image/bmp' }
  // SVG / XML — inspect the head as text
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 256)).trim().toLowerCase()
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg')) return { ext: 'svg', contentType: 'image/svg+xml' }
  // Trust an explicit image/* header as a last resort (e.g. odd favicons)
  const m = headerType.match(/^image\/([a-z0-9.+-]+)/i)
  if (m) return { ext: (m[1] === 'jpeg' ? 'jpg' : m[1]).replace(/[^a-z0-9]/g, '') || 'img', contentType: `image/${m[1]}` }
  return null
}

/** Decode a data: URI into bytes + content-type. */
function decodeDataUri(uri: string): { bytes: Uint8Array; contentType: string } | null {
  const m = uri.match(/^data:([^;,]+)?(;base64)?,(.*)$/i)
  if (!m) return null
  const contentType = m[1] || 'application/octet-stream'
  try {
    const bytes = m[2] ? new Uint8Array(Buffer.from(m[3], 'base64')) : new Uint8Array(Buffer.from(decodeURIComponent(m[3]), 'utf-8'))
    return { bytes, contentType }
  } catch { return null }
}

export async function downloadAndStoreLogo(admin: any, slug: string, candidates: string[]): Promise<string | null> {
  for (const url of candidates) {
    let bytes: Uint8Array | null = null
    let headerType = ''
    if (url.startsWith('data:')) {
      const d = decodeDataUri(url)
      if (d) { bytes = d.bytes; headerType = d.contentType }
    } else {
      const res = await fetchBinary(url, 6000, MAX_BYTES)
      if (res.ok && res.bytes) { bytes = res.bytes; headerType = res.contentType }
    }
    if (!bytes || bytes.length < MIN_BYTES) continue

    const kind = sniff(bytes, headerType)
    if (!kind) continue

    const path = `${slug}.${kind.ext}`
    try {
      const { error } = await admin.storage.from(LOGO_BUCKET).upload(path, Buffer.from(bytes), {
        contentType: kind.contentType,
        upsert: true, // allow manual re-enrichment to overwrite in place
      })
      if (error) {
        console.error(`[company-enrich] logo upload failed slug=${slug}: ${error.message}`)
        continue
      }
      const { data } = admin.storage.from(LOGO_BUCKET).getPublicUrl(path)
      const publicUrl = data?.publicUrl || null
      if (publicUrl) {
        // Cache-bust so a refreshed logo (same path) isn't masked by a CDN copy.
        return `${publicUrl}?v=${slug.length}${bytes.length}`
      }
    } catch (e: any) {
      console.error(`[company-enrich] logo store threw slug=${slug}: ${e?.message || e}`)
    }
  }
  return null
}
