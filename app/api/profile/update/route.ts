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
        seniority: formData.get('seniority'),
        expertise: expertise,
        purposes: purposes,
        meeting_format_preference: formData.get('meeting_format_preference'),
        geographic_scope: formData.get('geographic_scope'),
        bio: formData.get('bio'),
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
