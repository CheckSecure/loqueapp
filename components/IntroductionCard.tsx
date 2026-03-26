'use client'

export default function IntroductionCard({ 
  children, 
  targetId,
  rowId 
}: { 
  children: React.ReactNode
  targetId: string
  rowId?: string
}) {
  return (
    <div data-target-id={targetId} data-row-id={rowId || ''}>
      {children}
    </div>
  )
}
