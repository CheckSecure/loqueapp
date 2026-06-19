'use client'

import { createContext, useContext, useState, ReactNode } from 'react'

// ────────────────────────────────────────────────────────────────────────────
// UI Review Mode — write-safe demo card hider.
//
// STRUCTURAL safety: this module imports ONLY 'react'. It has no path to:
//   - @supabase, @/lib/supabase/*, supabase clients of any kind
//   - @/app/actions (passOnSuggestion, submitIntroRequest, etc.)
//   - @/components/RequestIntroButton (the real CTA)
//   - @/components/HideSuggestionButton
//   - fetch, axios, any HTTP client
//   - @/app/api/* helpers
// The hide() function it exposes can only call setState. Zero I/O.
//
// Renders children unless local `hidden` state is true, in which case it
// returns null. Provides a React Context so descendant components (e.g.
// DemoPassButton) can flip the hidden state on click. Per-instance — each
// wrapped card owns its own hidden state, so passing one demo card does not
// affect others. Refresh restores the card (state is local React state, not
// persisted).
//
// Only used when row.isDemo === true on the introductions page, behind the
// triple gate (NODE_ENV dev && Alexandra && ?demo=full).
// ────────────────────────────────────────────────────────────────────────────

const HideContext = createContext<() => void>(() => {})

export function useHideDemoCard(): () => void {
  return useContext(HideContext)
}

export default function DemoCardHider({ children }: { children: ReactNode }) {
  const [hidden, setHidden] = useState(false)
  if (hidden) return null
  return (
    <HideContext.Provider value={() => setHidden(true)}>
      {children}
    </HideContext.Provider>
  )
}
