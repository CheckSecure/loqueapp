import { NextRequest, NextResponse } from 'next/server'
import { buildProfileUpdate } from '@/lib/profile/updatePayload'
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

    // True partial update: every field is present-only (omitted → left unchanged),
    // built by a shared, unit-tested helper so no form can wipe fields it didn't
    // submit. Returns a validation error for the matcher's required-when-present
    // fields (role_type / seniority / expertise).
    const built = buildProfileUpdate(formData)
    if ('error' in built) {
      return NextResponse.json({ error: built.error }, { status: 400 })
    }

    const { data: updatedRows, error } = await supabase
      .from('profiles')
      .update({ ...built.payload, updated_at: new Date().toISOString() })
      .eq('id', user.id)
      .select('id')

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

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('[profile/update] exception:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
