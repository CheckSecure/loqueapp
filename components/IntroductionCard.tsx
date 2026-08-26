'use client'

import { useRouter } from 'next/navigation'

export default function IntroductionCard({
  children,
  targetId,
  rowId,
  /** Set on exactly ONE card per page — the first actionable one — so the "You have introductions
   *  waiting" reminder has a real element to scroll to and move keyboard focus into. */
  anchorId
}: {
  children: React.ReactNode
  targetId: string
  rowId?: string
  anchorId?: string
}) {
  const router = useRouter()

  function handleClick(e: React.MouseEvent) {
    // Let interactive controls inside the card (Request/Withdraw buttons, links)
    // keep their own behavior; only a click on the card body opens the profile.
    if ((e.target as HTMLElement).closest('button, a, input, textarea, [role="button"]')) return
    router.push(`/dashboard/profile/${targetId}`)
  }

  return (
    <div id={anchorId} data-target-id={targetId} data-row-id={rowId || ''} onClick={handleClick} className="cursor-pointer">
      {children}
    </div>
  )
}
