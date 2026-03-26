import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { computeAllScores } from '@/lib/scoring'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const cronSecret = req.headers.get('x-cron-secret')
    const isValidCron = cronSecret === process.env.CRON_SECRET

    if (!isValidCron) {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || user.email !== 'bizdev91@gmail.com') {
        return NextResponse.json({ error: 'Not authorized' }, { status: 401 })
      }
    }

    const result = await computeAllScores()
    return NextResponse.json({ success: true, ...result })
  } catch (err: any) {
    console.error('[compute-scores] error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
