import { Sparkles } from 'lucide-react'

/**
 * FoundingMemberBadge — small premium pill indicating a user has
 * is_founding_member = true.
 *
 * Visual: gold tokens, rounded-full, semibold + tracking-wide.
 * Sized for two contexts:
 *   - 'md' (default): standalone surfaces (e.g., billing page tier display)
 *   - 'sm':           inline next to a name in a tighter card layout
 */
export function FoundingMemberBadge({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const isSm = size === 'sm'
  const padding = isSm ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-xs'
  const iconSize = isSm ? 'w-2.5 h-2.5' : 'w-3 h-3'
  return (
    <span
      className={`inline-flex items-center gap-1 ${padding} font-semibold tracking-wide rounded-full bg-brand-gold/10 text-brand-gold border border-brand-gold/20`}
    >
      <Sparkles className={iconSize} />
      Founding Member
    </span>
  )
}
