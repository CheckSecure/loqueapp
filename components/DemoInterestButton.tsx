'use client'

import { useState } from 'react'

// ────────────────────────────────────────────────────────────────────────────
// UI Review Mode — write-safe demo CTA.
//
// STRUCTURAL safety: this module imports ONLY 'react'. It has no path to:
//   - @supabase, @/lib/supabase/*, supabase clients of any kind
//   - @/app/actions (submitIntroRequest, withdrawIntroRequest, etc.)
//   - @/components/RequestIntroButton (the real CTA)
//   - fetch, axios, any HTTP client
//   - @/app/api/* helpers
// The click handler can only call setState. The component re-renders the
// confirmed "Interest expressed" visual. Zero I/O. Write-safety is enforced
// by the module's import set, not by runtime intent.
//
// Only rendered when row.isDemo === true on the introductions page, which
// is only reachable behind the triple gate in page.tsx
// (NODE_ENV === 'development' && user.email === 'alexandra@horizoncapital.com'
//  && searchParams.demo === 'full').
// ────────────────────────────────────────────────────────────────────────────

interface Props {
  /** Compact py-2 sizing for the small additional cards. Default = featured-card py-2.5. */
  compact?: boolean
}

export default function DemoInterestButton({ compact = false }: Props) {
  const [expressed, setExpressed] = useState(false)
  const py = compact ? 'py-2' : 'py-2.5'

  if (expressed) {
    // Mirrors the page's real alreadyRequested confirmed visual — emerald
    // pill with check mark — sized to fill the button footprint for parity.
    return (
      <div className={`w-full flex items-center justify-center gap-1.5 bg-emerald-50 border border-emerald-200 rounded-lg ${py} px-3`}>
        <svg className="w-3 h-3 text-emerald-600" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/>
        </svg>
        <span className="text-xs font-medium text-emerald-700">Interest expressed</span>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setExpressed(true)}
      className={`w-full flex items-center justify-center gap-1.5 text-xs font-semibold bg-[#1B2850] text-white ${py} rounded-lg hover:bg-[#2E4080] transition-colors`}
    >
      Express interest
    </button>
  )
}
