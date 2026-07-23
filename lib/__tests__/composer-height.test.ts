import { describe, it, expect } from 'vitest'
import {
  clampComposerHeight,
  COMPOSER_MIN_HEIGHT,
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_ROWS,
  COMPOSER_MAX_ROWS,
} from '@/lib/messaging/composerHeight'

describe('clampComposerHeight — composer auto-resize math', () => {
  it('derives min/max from the row targets (6 default, 12 max ≈ 250px)', () => {
    expect(COMPOSER_MIN_ROWS).toBe(6)
    expect(COMPOSER_MAX_ROWS).toBe(12)
    expect(COMPOSER_MIN_HEIGHT).toBe(128) // 6*20 + 8
    expect(COMPOSER_MAX_HEIGHT).toBe(248) // 12*20 + 8 (~250px target)
  })

  it('pins short/empty content to the minimum (default 6-line height always shown)', () => {
    expect(clampComposerHeight(0)).toEqual({ height: COMPOSER_MIN_HEIGHT, overflowY: 'hidden' })
    expect(clampComposerHeight(28)).toEqual({ height: COMPOSER_MIN_HEIGHT, overflowY: 'hidden' }) // 1 line
    expect(clampComposerHeight(COMPOSER_MIN_HEIGHT)).toEqual({ height: COMPOSER_MIN_HEIGHT, overflowY: 'hidden' })
  })

  it('tracks content height exactly between min and max (auto-expand, no scroll)', () => {
    expect(clampComposerHeight(150)).toEqual({ height: 150, overflowY: 'hidden' })
    expect(clampComposerHeight(COMPOSER_MAX_HEIGHT)).toEqual({ height: COMPOSER_MAX_HEIGHT, overflowY: 'hidden' })
  })

  it('pins to max and enables internal scroll once content exceeds the max', () => {
    expect(clampComposerHeight(COMPOSER_MAX_HEIGHT + 1)).toEqual({ height: COMPOSER_MAX_HEIGHT, overflowY: 'auto' })
    expect(clampComposerHeight(500)).toEqual({ height: COMPOSER_MAX_HEIGHT, overflowY: 'auto' })
  })

  it('ceils sub-pixel scrollHeight so the last line never clips', () => {
    expect(clampComposerHeight(150.2).height).toBe(151)
  })

  it('respects custom min/max overrides', () => {
    expect(clampComposerHeight(10, 40, 200)).toEqual({ height: 40, overflowY: 'hidden' })
    expect(clampComposerHeight(300, 40, 200)).toEqual({ height: 200, overflowY: 'auto' })
  })
})
