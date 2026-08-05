import { Sparkles, Check, MessageCircle } from 'lucide-react'
import type { MatchSignal } from '@/lib/matchIntelligence'

/** "Conversation starters" sub-section — rendered only when at least one exists. */
function ConversationStarters({ starters, tone }: { starters?: string[]; tone: 'boxed' | 'bare' }) {
  if (!starters || starters.length === 0) return null
  const items = starters.slice(0, 3)
  return (
    <div className="mt-3">
      <p className={`text-[10px] uppercase tracking-[0.14em] font-bold mb-1 ${tone === 'boxed' ? 'text-brand-gold/80' : 'text-slate-400'}`}>
        Conversation starters
      </p>
      <ul className="space-y-1">
        {items.map((s) => (
          <li key={s} className="flex items-start gap-1.5 text-xs text-slate-600 leading-relaxed">
            <MessageCircle className="w-3.5 h-3.5 text-brand-gold/70 flex-shrink-0 mt-0.5" />
            <span>{s}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Match Intelligence card (Phase A, display-only). Renders, in priority order:
 *   1. up to 5 structured signals (when the builder produced any), else
 *   2. the stored intro_requests.match_reason — preserving the newline-bullet
 *      contract (multi-line → bulleted list, single line → prose), else
 *   3. a generic fallback line.
 *
 * Pure presentational component (no client hooks) so it can be used from server
 * components (the introductions page) AND client components (the intro cards).
 * Structured signals REPLACE the stored reason when present, so the two never show
 * at once — no duplicate concepts. Nothing here reads focus areas / roles / scoring.
 */

const GENERIC_FALLBACK = 'Curated based on your profile and preferences.'

function FallbackReason({ reason }: { reason: string | null | undefined }) {
  const text = (reason ?? '').trim()
  if (!text) return <p className="text-xs text-slate-600 leading-relaxed">{GENERIC_FALLBACK}</p>
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length > 1) {
    return (
      <ul className="list-disc list-inside text-xs text-slate-600 space-y-0.5">
        {lines.map((l) => <li key={l}>{l}</li>)}
      </ul>
    )
  }
  return <p className="text-xs text-slate-600 leading-relaxed">{lines[0] ?? text}</p>
}

export default function MatchIntelligenceCard({
  signals,
  starters,
  fallbackReason,
  title = 'Why we recommended this connection',
  variant = 'boxed',
}: {
  signals: MatchSignal[]
  starters?: string[]
  fallbackReason?: string | null
  title?: string
  variant?: 'boxed' | 'bare'
}) {
  const hasSignals = signals && signals.length > 0

  // ── bare: just the content, for the introductions page's reason slot ────────
  if (variant === 'bare') {
    if (!hasSignals) return <FallbackReason reason={fallbackReason} />
    return (
      <>
        <ul className="space-y-1">
          {signals.map((s) => (
            <li key={s.key} className="flex items-start gap-1.5 text-xs text-slate-600 leading-relaxed">
              <Check className="w-3.5 h-3.5 text-brand-gold flex-shrink-0 mt-0.5" />
              <span>{s.label}</span>
            </li>
          ))}
        </ul>
        <ConversationStarters starters={starters} tone="bare" />
      </>
    )
  }

  // ── boxed: the gold "why" card used on the intro cards ──────────────────────
  return (
    <div className="rounded-lg bg-gradient-to-br from-brand-gold-soft via-brand-gold-soft/60 to-white border border-brand-gold/25 px-3.5 py-2.5">
      <div className="flex items-start gap-2.5">
        <Sparkles className="w-4 h-4 text-brand-gold flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-[0.14em] font-bold text-brand-gold mb-1.5">{title}</p>
          {hasSignals ? (
            <>
              <ul className="space-y-1">
                {signals.map((s) => (
                  <li key={s.key} className="flex items-start gap-1.5 text-sm text-brand-navy leading-snug">
                    <Check className="w-3.5 h-3.5 text-brand-gold flex-shrink-0 mt-0.5" />
                    <span>{s.label}</span>
                  </li>
                ))}
              </ul>
              <ConversationStarters starters={starters} tone="boxed" />
            </>
          ) : (
            <FallbackReason reason={fallbackReason} />
          )}
        </div>
      </div>
    </div>
  )
}
