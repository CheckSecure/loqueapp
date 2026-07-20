import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isEnrichmentEnabled } from '@/lib/company/provider'

const ADMIN_EMAIL = 'bizdev91@gmail.com'

/**
 * Runtime diagnostic: reports whether company enrichment is enabled in THIS
 * deployment (i.e. whether COMPANIES_API_KEY is present at runtime). Returns
 * booleans + the key LENGTH only — never the key value. Admin-only.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const key = process.env.COMPANIES_API_KEY || ''
  return NextResponse.json({
    enrichmentEnabled: isEnrichmentEnabled(),
    keyPresent: key.trim().length > 0,
    keyLength: key.length,
    base: process.env.COMPANIES_API_BASE || 'https://api.thecompaniesapi.com/v2 (default)',
    vercelEnv: process.env.VERCEL_ENV || null,
  })
}
