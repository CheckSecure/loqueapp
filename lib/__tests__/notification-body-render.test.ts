import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const PAGE = readFileSync('app/dashboard/notifications/page.tsx', 'utf8')
const BELL = readFileSync('components/NotificationBell.tsx', 'utf8')
const LIB = readFileSync('lib/notifications/index.ts', 'utf8')

describe('notification body renders on BOTH surfaces', () => {
  it('the column really is `body` — the writer says so', () => {
    expect(LIB).toContain('body: copy.message')
  })

  it('the notifications page reads body, not the non-existent message', () => {
    // /api/notifications/list does select('*'), so the row carries `body`. Declaring `message`
    // made the value undefined and silently hid every notification body on this page.
    expect(PAGE).toContain('body: string | null')
    expect(PAGE).toContain('{notification.body && (')
    expect(PAGE).not.toContain('notification.message')
  })

  it('the bell still reads body', () => {
    expect(BELL).toContain('body: string')
    expect(BELL).toContain('{n.body}')
  })
})
