'use client'

import { ChevronRight } from 'lucide-react'
import { OPEN_TUTORIAL_EVENT } from '@/components/Tutorial'

// Opens the guided tutorial (rendered in the dashboard layout) at step 1 via a
// window event. Does not read or write the tutorial's localStorage dismissal
// state, so replaying never affects normal first-run behavior.
export default function TutorialReplayButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_TUTORIAL_EVENT))}
      className="inline-flex items-center gap-1.5 rounded-xl bg-brand-navy px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-navy-dark"
    >
      View tutorial
      <ChevronRight className="h-4 w-4" aria-hidden="true" />
    </button>
  )
}
