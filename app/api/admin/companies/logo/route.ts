import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { validateLogoBytes } from '@/lib/company/imageSniff'
import { LOGO_BUCKET } from '@/lib/company/enrichment/logo'

export const runtime = 'nodejs'
export const maxDuration = 60

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * Admin-only direct logo upload. Accepts a multipart file (PNG/JPG/SVG/ICO),
 * validates it by magic bytes + size (rejects broken / tiny / placeholder / wrong
 * type), stores OUR OWN copy in the existing `company-logos` bucket at
 * `<slug>.<ext>`, and returns the permanent public URL for companies.logo_url.
 * Never stores an external URL. Does not touch the enrichment pipeline.
 */
export async function POST(request: Request) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart form data.' }, { status: 400 })
  }

  const slug = String(form.get('slug') || '').toLowerCase().trim()
  const file: any = form.get('file')
  if (!slug) return NextResponse.json({ error: 'Missing slug.' }, { status: 400 })
  if (!file || typeof file.arrayBuffer !== 'function') {
    return NextResponse.json({ error: 'Missing file.' }, { status: 400 })
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const v = validateLogoBytes(bytes, typeof file.type === 'string' ? file.type : '')
  if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 400 })

  const admin = createAdminClient()
  const path = `${slug}.${v.ext}`
  const { error } = await admin.storage.from(LOGO_BUCKET).upload(path, Buffer.from(bytes), {
    contentType: v.contentType,
    upsert: true, // allow re-upload to overwrite in place
  })
  if (error) {
    return NextResponse.json({ error: `Upload failed: ${error.message}` }, { status: 500 })
  }
  const { data } = admin.storage.from(LOGO_BUCKET).getPublicUrl(path)
  const publicUrl = data?.publicUrl
  if (!publicUrl) return NextResponse.json({ error: 'Could not resolve public URL.' }, { status: 500 })

  // Cache-bust so a replaced logo (same path) isn't masked by a CDN copy.
  return NextResponse.json({ ok: true, url: `${publicUrl}?v=${bytes.length}` })
}
