import { describe, it, expect } from 'vitest'
import {
  nyParts, nyOffsetMinutes, nextBatch, currentCycleBatch, countdownState, formatCountdown,
  weeklyRunKey, THURSDAY, CRON_HOUR_UTC,
} from '@/lib/introductions/thursdaySchedule'

// The single Hobby cron is `0 14 * * 4` → Thursday 14:00 UTC. That fixed UTC hour is 09:xx ET under
// EST and 10:xx ET under EDT. Reference Thursdays:
const THU_EDT = new Date('2026-08-20T14:00:00Z') // NY 10:00 EDT
const THU_EST = new Date('2026-01-15T14:00:00Z') // NY 09:00 EST

describe('honest local timing — fixed 14:00 UTC hour shifts between 9 AM (EST) and 10 AM (EDT) ET', () => {
  it('EST Thursday 14:00 UTC is 09:00 in New York', () => {
    const p = nyParts(THU_EST)
    expect(p.weekday).toBe(THURSDAY)
    expect(p.hour).toBe(9)
    expect(nyOffsetMinutes(THU_EST)).toBe(-300)
  })
  it('EDT Thursday 14:00 UTC is 10:00 in New York', () => {
    const p = nyParts(THU_EDT)
    expect(p.weekday).toBe(THURSDAY)
    expect(p.hour).toBe(10)
    expect(nyOffsetMinutes(THU_EDT)).toBe(-240)
  })
  it('the cron hour is 14:00 UTC (not a NY wall-clock hour)', () => {
    expect(CRON_HOUR_UTC).toBe(14)
  })
})

describe('nextBatch — targets the real UTC cron window (Thursday 14:00 UTC)', () => {
  it('from mid-week returns this week’s Thursday 14:00 UTC', () => {
    expect(nextBatch(new Date('2026-08-19T18:00:00Z')).toISOString()).toBe('2026-08-20T14:00:00.000Z')
  })
  it('one minute before the window still targets today’s 14:00 UTC', () => {
    expect(nextBatch(new Date('2026-08-20T13:59:00Z')).toISOString()).toBe('2026-08-20T14:00:00.000Z')
  })
})

describe('Hobby imprecise invocation window [14:00, 15:00) UTC — target stays pinned, no early rollover', () => {
  it('at 14:00 (window start) the target is still today (countdown reads as arriving, not next week)', () => {
    expect(nextBatch(new Date('2026-08-20T14:00:00Z')).toISOString()).toBe('2026-08-20T14:00:00.000Z')
  })
  it('at 14:30 (mid-window, Vercel may still invoke) the target is still today', () => {
    expect(nextBatch(new Date('2026-08-20T14:30:00Z')).toISOString()).toBe('2026-08-20T14:00:00.000Z')
    expect(countdownState(new Date('2026-08-20T14:30:00Z')).totalMs).toBe(0) // clamped, "arriving"
  })
  it('rolls forward to next Thursday ONLY after the window ends (15:00 UTC)', () => {
    expect(nextBatch(new Date('2026-08-20T15:00:00Z')).toISOString()).toBe('2026-08-27T14:00:00.000Z')
    expect(nextBatch(new Date('2026-08-20T15:00:01Z')).toISOString()).toBe('2026-08-27T14:00:00.000Z')
  })
})

describe('year boundary', () => {
  it('Wed Dec 30 2026 → Thu Dec 31 2026 14:00 UTC (same year)', () => {
    expect(nextBatch(new Date('2026-12-30T18:00:00Z')).toISOString()).toBe('2026-12-31T14:00:00.000Z')
  })
  it('after Thu Dec 31 window → Thu Jan 7 2027 (crosses into next year)', () => {
    expect(nextBatch(new Date('2026-12-31T15:30:00Z')).toISOString()).toBe('2027-01-07T14:00:00.000Z')
  })
})

describe('countdownState — never negative', () => {
  it('breaks remaining time into d/h/m/s', () => {
    const cd = countdownState(new Date('2026-08-18T11:00:00Z'), THU_EDT) // 2d 3h before
    expect(cd.days).toBe(2)
    expect(cd.hours).toBe(3)
    expect(cd.pending).toBe(true)
  })
  it('is exactly zero at the target (not negative)', () => {
    const cd = countdownState(THU_EDT, THU_EDT)
    expect(cd.totalMs).toBe(0)
    expect(cd.days + cd.hours + cd.minutes + cd.seconds).toBe(0)
    expect(cd.pending).toBe(false)
  })
  it('CLAMPS to zero when now is past the target (no negative countdown)', () => {
    expect(countdownState(new Date('2026-08-20T20:00:00Z'), THU_EDT).totalMs).toBe(0)
  })
})

describe('formatCountdown — human copy, no negatives, no exact-hour claim', () => {
  it('days + hours', () => {
    expect(formatCountdown(countdownState(new Date('2026-08-18T11:00:00Z'), THU_EDT))).toBe('2 days, 3 hours remaining')
  })
  it('singular units', () => {
    expect(formatCountdown(countdownState(new Date('2026-08-19T12:00:00Z'), THU_EDT))).toBe('1 day, 2 hours remaining')
  })
  it('hours + minutes under a day', () => {
    expect(formatCountdown(countdownState(new Date('2026-08-20T10:30:00Z'), THU_EDT))).toBe('3 hours, 30 minutes remaining')
  })
  it('sub-minute and past-target never render negative time', () => {
    expect(formatCountdown(countdownState(new Date('2026-08-20T13:59:40Z'), THU_EDT))).toBe('Less than a minute remaining')
    expect(formatCountdown(countdownState(THU_EDT, THU_EDT))).toBe('Arriving shortly')
    expect(formatCountdown(countdownState(new Date('2026-08-20T20:00:00Z'), THU_EDT))).toBe('Arriving shortly')
  })
})

describe('currentCycleBatch — most recent Thursday window START, correct during the live window', () => {
  it('mid-week points at the prior Thursday', () => {
    expect(currentCycleBatch(new Date('2026-08-18T12:00:00Z')).toISOString()).toBe('2026-08-13T14:00:00.000Z')
  })
  it('DURING the live window it points at TODAY (not last week)', () => {
    expect(currentCycleBatch(new Date('2026-08-20T14:30:00Z')).toISOString()).toBe('2026-08-20T14:00:00.000Z')
  })
  it('before the window (Thu 13:00) it still points at last Thursday', () => {
    expect(currentCycleBatch(new Date('2026-08-20T13:00:00Z')).toISOString()).toBe('2026-08-13T14:00:00.000Z')
  })
})

describe('weeklyRunKey — non-authoritative per-week LOG LABEL (not a durable exactly-once claim)', () => {
  it('labels the run with THIS Thursday’s UTC date during the invocation window', () => {
    expect(weeklyRunKey(new Date('2026-08-20T14:00:00Z'))).toBe('thu-2026-08-20')
    expect(weeklyRunKey(new Date('2026-08-20T14:45:00Z'))).toBe('thu-2026-08-20')
  })
  it('distinct the following week', () => {
    expect(weeklyRunKey(new Date('2026-08-27T14:00:00Z'))).toBe('thu-2026-08-27')
  })
  it('mid-week points at the current cycle’s Thursday', () => {
    expect(weeklyRunKey(new Date('2026-08-18T12:00:00Z'))).toBe('thu-2026-08-13')
  })
})

describe('no NY-hour execution guard is exported (single weekly invocation)', () => {
  it('mayCronExecute has been removed from the helper', async () => {
    const mod: any = await import('@/lib/introductions/thursdaySchedule')
    expect(mod.mayCronExecute).toBeUndefined()
  })
})
