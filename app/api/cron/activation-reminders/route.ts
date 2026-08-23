import { NextResponse } from 'next/server'

/**
 * SUPERSEDED — this route no longer sends anything.
 *
 * It previously sent two "activation reminders" whose only call to action was a link to
 * /auth/forgot-password, the password-reset flow. It also disqualified anyone whose auth user had
 * last_sign_in_at set — so the people who signed in and stalled mid-onboarding, the exact cohort a
 * reminder exists for, could never be reminded again. And its stage-1 window was 23–48h with
 * stage 2 gated behind stage 1, so one missed run stranded a person permanently.
 *
 * The replacement is the staged onboarding-reminder worker in lib/onboarding/reminderWorker.ts,
 * which runs inside the daily engagement-reminders maintenance invocation.
 *
 * THIS FILE IS KEPT AS A DELIBERATE NO-OP rather than deleted, because vercel.json still declares a
 * cron for this path. Deleting the route would turn a scheduled invocation into a 404 that nothing
 * watches; keeping it as an explicit, authenticated no-op means the schedule is harmless and the
 * reason is recorded where whoever finds it will look. It writes no timestamp, so no recipient is
 * marked as reminded by a run that sent nothing.
 */
export async function GET(req: Request) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  console.log('[activation-reminders] superseded no-op; staged reminders run in engagement-reminders')
  return NextResponse.json({
    superseded: true,
    replacement: 'lib/onboarding/reminderWorker.ts (runs in /api/cron/engagement-reminders)',
    sent: 0,
  })
}
