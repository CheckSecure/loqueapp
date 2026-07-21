import { NextRequest, NextResponse } from 'next/server'
import { buildProfileUpdate } from '@/lib/profile/updatePayload'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { verifyLinkedInConsistency } from '@/app/actions/verify-linkedin'
import { checkProfileCompletion } from '@/lib/trust/signals'
import { isLinkableCompany, companySlug } from '@/lib/company/slug'
import { scheduleEnrichment } from '@/lib/company/enrichment/schedule'

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const formData = await req.formData()

    // True partial update: every field is present-only (omitted → left unchanged),
    // built by a shared, unit-tested helper so no form can wipe fields it didn't
    // submit. Returns a validation error for the matcher's required-when-present
    // fields (role_type / seniority / expertise).
    const built = buildProfileUpdate(formData)
    if ('error' in built) {
      return NextResponse.json({ error: built.error }, { status: 400 })
    }

    // Capture the prior company ONLY when this request submits one, so an actual
    // company change can be told apart from an unrelated-field save.
    const companySubmitted = 'company' in built.payload
    let priorCompany: string | null = null
    if (companySubmitted) {
      const { data: prior } = await supabase.from('profiles').select('company').eq('id', user.id).maybeSingle()
      priorCompany = (prior?.company as string | null) ?? null
    }

    const { data: updatedRows, error } = await supabase
      .from('profiles')
      .update({ ...built.payload, updated_at: new Date().toISOString() })
      .eq('id', user.id)
      .select('id, company')

    if (error) {
      console.error('[profile/update] error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!updatedRows || updatedRows.length === 0) {
      // Row not updated (missing profile / RLS) — never report a false success.
      console.error('[profile/update] update affected 0 rows for', user.id)
      return NextResponse.json({ error: 'Could not save your changes. Please try again.' }, { status: 409 })
    }

    // Run LinkedIn verification
    await verifyLinkedInConsistency(user.id, {
      fullName: formData.get('full_name') as string,
      title: formData.get('title') as string,
      company: formData.get('company') as string,
      linkedinUrl: formData.get('linkedinUrl') as string | undefined
    })

    // Check and track profile completion
    await checkProfileCompletion(user.id)

    // Company enrichment — the same background pipeline the /dashboard/profile
    // server action fires, so every real save path is covered. Runs ONLY after a
    // successful update (we're past the error/0-row guards above) and off the
    // FINAL PERSISTED company value, never the raw request. Fires when the
    // company genuinely changed, or when its page record is still missing or
    // unenriched (opportunistic backfill) — but NOT when an unrelated field
    // changed and the company is already enriched. Async via scheduleEnrichment
    // (waitUntil), so it never blocks this response; runEnrichment's atomic claim
    // preserves admin overrides, dedup, and the retry window, with the weekly
    // cron as the fallback.
    const newCompany = (updatedRows[0]?.company as string | null) ?? null
    if (isLinkableCompany(newCompany)) {
      const slug = companySlug(newCompany)
      const changed = companySubmitted && companySlug(priorCompany) !== slug
      const admin = createAdminClient()
      let shouldEnrich = changed
      if (!shouldEnrich) {
        const { data: row } = await admin
          .from('companies')
          .select('slug, admin_edited, enrichment_status')
          .eq('slug', slug)
          .maybeSingle()
        shouldEnrich = !row || (!row.admin_edited && row.enrichment_status !== 'enriched')
      }
      if (shouldEnrich) scheduleEnrichment(admin, slug, (newCompany as string).trim())
    }

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[profile/update] exception:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
