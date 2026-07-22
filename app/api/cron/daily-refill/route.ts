import { NextResponse } from 'next/server'

/**
 * RETIRED. The recommendation cycle now releases exactly RECOMMENDATIONS_PER_BATCH
 * per member on a single WEEKLY cadence, gated on batch completion
 * (see app/api/cron/weekly-refresh). Daily top-ups are intentionally gone so members
 * cannot rapidly cycle through the network. This handler is a no-op and is removed
 * from vercel.json crons; kept only so any stale reference resolves harmlessly.
 */
export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ success: true, retired: true, message: 'daily-refill retired; recommendations release weekly via weekly-refresh' })
}
