import { NextRequest, NextResponse } from 'next/server'
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
    
    const expertise = (formData.get('expertise') as string || '')
      .split(',').map(s => s.trim()).filter(Boolean)
    const purposes = (formData.get('purposes') as string || '')
      .split(',').map(s => s.trim()).filter(Boolean)
    const introPref = (formData.get('intro_preferences') as string || '')
      .split(',').map(s => s.trim()).filter(Boolean)

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
        role_type: formData.get('role_type'),
        seniority: formData.get('seniority'),
        expertise: expertise,
        intro_preferences: introPref,
        purposes: purposes,
        meeting_format_preference: formData.get('meeting_format_preference'),
        geographic_scope: formData.get('geographic_scope'),
        open_to_business_solutions: formData.get('open_to_business_solutions') === 'true',
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
