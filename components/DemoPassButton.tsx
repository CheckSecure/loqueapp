'use client'

import { X } from 'lucide-react'
import { useHideDemoCard } from './DemoCardHider'

// ────────────────────────────────────────────────────────────────────────────
// UI Review Mode — write-safe demo pass button.
//
// STRUCTURAL safety: this module imports ONLY 'lucide-react' (the X icon, a
// pure SVG component with no side effects) and the local DemoCardHider hook
// (which imports only 'react'). It has no path to:
//   - @supabase, @/lib/supabase/*, supabase clients of any kind
//   - @/app/actions (passOnSuggestion, submitIntroRequest, etc.)
//   - @/components/RequestIntroButton (the real CTA)
//   - @/components/HideSuggestionButton
//   - fetch, axios, any HTTP client
//   - @/app/api/* helpers
// The click handler can only call the context-supplied hide() function,
// which itself can only call setState on the ancestor DemoCardHider. Zero I/O.
// If used without a DemoCardHider ancestor, hide() falls back to a no-op
// (the default context value), so the click does nothing.
//
// Only rendered when row.isDemo === true on the introductions page, which is
// only reachable behind the triple gate in page.tsx
// (NODE_ENV === 'development' && user.email === 'alexandra@horizoncapital.com'
//  && searchParams.demo === 'full').
// ────────────────────────────────────────────────────────────────────────────

interface Props {
  /** Compact py-2 sizing for the smaller weekly cards. Default = featured-card py-2.5. */
  compact?: boolean
}

export default function DemoPassButton({ compact = false }: Props) {
  const hide = useHideDemoCard()
  const py = compact ? 'py-2' : 'py-2.5'

  return (
    <button
      type="button"
      onClick={hide}
      className={`flex items-center justify-center px-2.5 ${py} text-slate-400 border border-slate-200 rounded-lg hover:bg-slate-50 hover:text-slate-600 transition-colors`}
      title="Pass"
      aria-label="Pass on this introduction"
    >
      <X className="w-3.5 h-3.5" />
    </button>
  )
}
