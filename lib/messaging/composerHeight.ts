// Auto-resize math for the message composer textarea.
//
// The composer grows with its content from a comfortable multi-line default up
// to a maximum, after which it scrolls internally. The height math is kept here
// as a pure function so it can be unit-tested without a DOM, and so the min/max
// are single-sourced between the component's inline styles and the resize logic.
//
// Heights are derived from the textarea's own metrics (text-sm + leading-5 =
// 20px line height, py-1 = 8px vertical padding) so `rows` and the pixel caps
// stay in agreement.

export const COMPOSER_LINE_HEIGHT = 20 // px — Tailwind leading-5 on text-sm
export const COMPOSER_VERTICAL_PADDING = 8 // px — Tailwind py-1 (top + bottom)
export const COMPOSER_MIN_ROWS = 6
export const COMPOSER_MAX_ROWS = 12

// ~6 lines of comfortable default (128px) — enough to type a full paragraph
// before expansion — growing to ~12 lines (248px ≈ the ~250px target) before
// internal scrolling kicks in.
export const COMPOSER_MIN_HEIGHT = COMPOSER_MIN_ROWS * COMPOSER_LINE_HEIGHT + COMPOSER_VERTICAL_PADDING
export const COMPOSER_MAX_HEIGHT = COMPOSER_MAX_ROWS * COMPOSER_LINE_HEIGHT + COMPOSER_VERTICAL_PADDING

/**
 * Clamp a measured textarea scrollHeight into the composer's [min, max] range and
 * decide whether it should scroll internally.
 *
 * - Below the minimum → pinned to the minimum (the 5-line default is always shown).
 * - Between min and max → tracks content height exactly (auto-expand).
 * - Above the maximum → pinned to the maximum and overflowY becomes 'auto' so the
 *   textarea scrolls internally instead of growing further.
 *
 * scrollHeight is ceil'd so sub-pixel content heights never clip the last line.
 */
export function clampComposerHeight(
  scrollHeight: number,
  minHeight: number = COMPOSER_MIN_HEIGHT,
  maxHeight: number = COMPOSER_MAX_HEIGHT,
): { height: number; overflowY: 'auto' | 'hidden' } {
  const measured = Math.ceil(scrollHeight)
  const height = Math.min(Math.max(measured, minHeight), maxHeight)
  return { height, overflowY: measured > maxHeight ? 'auto' : 'hidden' }
}
