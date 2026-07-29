/**
 * Standalone image validation for admin logo UPLOADS (direct file bytes), kept
 * separate from the enrichment pipeline's URL-download path (enrichment/logo.ts)
 * so this module is pure and unit-testable. Identifies an image by magic bytes —
 * we trust the content, not the client-supplied MIME — and enforces the accepted
 * set for logos: PNG, JPG, SVG, ICO.
 */

export const MIN_LOGO_BYTES = 200          // reject 1x1 trackers / placeholders / empty
export const MAX_LOGO_BYTES = 5_000_000

export type LogoExt = 'png' | 'jpg' | 'svg' | 'ico'
export interface LogoKind { ext: LogoExt; contentType: string }

/**
 * Identify PNG / JPG / SVG / ICO strictly by CONTENT (magic bytes for the binary
 * formats, an <svg>/<?xml head for SVG). The client-supplied MIME is deliberately
 * NOT trusted — a junk file labeled "image/png" must be rejected.
 */
export function sniffLogo(bytes: Uint8Array): LogoKind | null {
  const b = bytes
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', contentType: 'image/png' }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', contentType: 'image/jpeg' }
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return { ext: 'ico', contentType: 'image/x-icon' }
  // SVG / XML — inspect the head as text
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 256)).trim().toLowerCase()
  if (head.startsWith('<?xml') || head.startsWith('<svg') || head.includes('<svg')) return { ext: 'svg', contentType: 'image/svg+xml' }
  return null
}

export type LogoValidation =
  | { ok: true; ext: LogoExt; contentType: string }
  | { ok: false; reason: string }

/**
 * Validate uploaded bytes: non-empty, not tiny, not oversized, and a REAL
 * PNG/JPG/SVG/ICO by content. `_headerType` (the client MIME) is accepted for
 * call-site clarity but intentionally ignored — content is the source of truth.
 */
export function validateLogoBytes(bytes: Uint8Array | null | undefined, _headerType = ''): LogoValidation {
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'Empty or unreadable file.' }
  if (bytes.length < MIN_LOGO_BYTES) return { ok: false, reason: 'Image is too small (looks like a placeholder or tracking pixel).' }
  if (bytes.length > MAX_LOGO_BYTES) return { ok: false, reason: 'Image is too large (max 5 MB).' }
  const kind = sniffLogo(bytes)
  if (!kind) return { ok: false, reason: 'Not a valid image — accepted formats are PNG, JPG, SVG, and ICO.' }
  return { ok: true, ext: kind.ext, contentType: kind.contentType }
}
