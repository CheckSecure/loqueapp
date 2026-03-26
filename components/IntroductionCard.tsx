'use client'

import { useState } from 'react'

export default function IntroductionCard({ 
  children, 
  targetId 
}: { 
  children: React.ReactNode
  targetId: string
}) {
  const [hidden, setHidden] = useState(false)

  if (hidden) return null

  return (
    <div data-target-id={targetId} className="intro-card-wrapper">
      {children}
    </div>
  )
}
