import { NextRequest, NextResponse } from 'next/server'
import { parseMultiSelectField } from '@/lib/profile/multiSelect'
import { createClient } from '@/lib/supabase/server'
import { verifyLinkedInConsistency } from '@/app/actions/verify-linkedin'
import { checkProfileCompletion } from '@/lib/trust/signals'

export async function POST(req: NextRequest) {
  try {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const formData = await req.formData()

    const purposes = parseMultiSelectField(formData.get('purposes'))
    const interests = parseMultiSelectField(formData.get('interests'))
    const introPref = (formData.get('intro_preferences') as string || '')
      .split(',').map(s => s.trim()).filter(Boolean)

    // Present-only validation for the matcher's three strict candidate-filter
    // fields (lib/generate-recommendations.ts:889-894). Partial updates that
    // don't submit these fields (e.g., the preferences-step or a bio-only
    // edit) leave the existing DB value untouched. Updates that DO submit
    // these fields must keep them non-empty — preventing accidental clearing.
    let roleTypeToWrite: string | undefined
    if (formData.has('role_type')) {
      roleTypeToWrite = (formData.get('role_type') as string || '').trim()
      if (!roleTypeToWrite) {
        return NextResponse.json({ error: 'Please select your professional role' }, { status: 400 })
      }
    }
    let seniorityToWrite: string | undefined
    if (formData.has('seniority')) {
      seniorityToWrite = (formData.get('seniority') as string || '').trim()
      if (!seniorityToWrite) {
        return NextResponse.json({ error: 'Please select your seniority level' }, { status: 400 })
      }
    }
    let expertiseToWrite: string[] | undefined
    if (formData.has('expertise')) {
      expertiseToWrite = (formData.get('expertise') as string || '')
        .split(',').map(s => s.trim()).filter(Boolean)
      if (expertiseToWrite.length === 0) {
        return NextResponse.json({ error: 'Please select at least one area of expertise' }, { status: 400 })
      }
    }

    // Phase D: exact_job_title is display-only (never read by matching/scoring).
    // Present-only update — partial updates that don't submit the field leave
    // the existing value alone. Empty/whitespace value clears it to NULL.
    let exactJobTitleToWrite: string | null | undefined
    if (formData.has('exact_job_title')) {
      const trimmed = ((formData.get('exact_job_title') as string) || '').trim()
      exactJobTitleToWrite = trimmed.length > 0 ? trimmed : null
    }

    const currentStatusRaw = (formData.get('current_status') as string || '').trim()
    const currentStatus = currentStatusRaw || null

    let parsedPreviousRoles: any[] = []
    const previousRolesRaw = formData.get('previous_roles') as string
    if (previousRolesRaw) {
      try {
        const parsed = JSON.parse(previousRolesRaw)
        if (Array.isArray(parsed)) {
          parsedPreviousRoles = parsed
            .filter((r: any) => r.company?.trim() && r.title?.trim())
            .slice(0, 5)
            .map((r: any) => ({
              company: r.company.trim(),
              title: r.title.trim(),
              start_date: r.start_date?.trim() || null,
              end_date: r.end_date?.trim() || null,
            }))
        }
      } catch { /* malformed JSON — ignore */ }
    }

    const city = (formData.get('city') as string || '').trim()
    const state = (formData.get('state') as string || '').trim()
    const location = city && state ? `${city}, ${state}` : city || state || null

    const { error } = await supabase
      .from('profiles')
      .update({
        full_name: formData.get('full_name'),
        title: formData.get('title'),
        company: formData.get('company'),
        city: city || null,
        state: state || null,
        location: location,
        ...(roleTypeToWrite !== undefined && { role_type: roleTypeToWrite }),
        ...(seniorityToWrite !== undefined && { seniority: seniorityToWrite }),
        ...(expertiseToWrite !== undefined && { expertise: expertiseToWrite }),
        ...(exactJobTitleToWrite !== undefined && { exact_job_title: exactJobTitleToWrite }),
        intro_preferences: introPref,
        // Present-only: write goals/interests ONLY when this form submitted them,
        // so a partial save (a form without these fields) can never wipe them.
        ...(formData.has('purposes') && { purposes }),
        ...(formData.has('interests') && { interests }),
        meeting_format_preference: formData.get('meeting_format_preference'),
        geographic_scope: formData.get('geographic_scope'),
        ...(formData.has('open_to_business_solutions') && {
          open_to_business_solutions: formData.get('open_to_business_solutions') === 'true',
        }),
        bio: formData.get('bio'),
        current_status: currentStatus,
        previous_roles: parsedPreviousRoles,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id)

    if (error) {
      console.error('[profile/update] error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
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

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[profile/update] exception:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
