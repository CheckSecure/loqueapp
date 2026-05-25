'use client'

import { useRouter } from 'next/navigation'

export default function IntroductionCard({
  children,
  targetId,
  rowId
}: {
  children: React.ReactNode
  targetId: string
  rowId?: string
}) {
  const router = useRouter()

  function handleClick(e: React.MouseEvent) {
    // Let interactive controls inside the card (Request/Withdraw buttons, links)
    // keep their own behavior; only a click on the card body opens the profile.
    if ((e.target as HTMLElement).closest('button, a, input, textarea, [role="button"]')) return
    router.push(`/dashboard/profile/${targetId}`)
  }

  return (
    <div data-target-id={targetId} data-row-id={rowId || ''} onClick={handleClick} className="cursor-pointer">
      {children}
    </div>
  )
}
