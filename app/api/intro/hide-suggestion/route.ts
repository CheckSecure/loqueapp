import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  try {
    const { rowId } = await req.json()
    const supabase = createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Update the batch suggestion status to hidden_permanent
    const { error } = await supabase
      .from('batch_suggestions')
      .update({ status: 'hidden_permanent' })
      .eq('id', rowId)
      .eq('recipient_id', user.id) // Security: only hide your own suggestions

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Hide suggestion error:', error)
    return NextResponse.json({ error: 'Failed to hide suggestion' }, { status: 500 })
  }
}
