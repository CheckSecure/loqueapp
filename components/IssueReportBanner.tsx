'use client'

import { useState } from 'react'

export default function IssueReportBanner({
  reportedAt,
  reportText,
}: {
  reportedAt: string
  reportText: string
}) {
  const [expanded, setExpanded] = useState(false)

  const date = new Date(reportedAt).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  })

  return (
    <div className="border border-t-0 border-b-0 border-gray-200 bg-slate-50 px-4 py-3">
      <p className="text-xs text-slate-500">
        This conversation started from an issue report submitted on {date}.
      </p>
      <button
        onClick={() => setExpanded(v => !v)}
        className="text-xs text-slate-400 hover:text-slate-600 mt-0.5 transition-colors"
      >
        {expanded ? 'Hide details' : 'Show details'}
      </button>
      {expanded && (
        <p className="text-sm text-slate-600 mt-2 pt-2 border-t border-slate-200">
          {reportText}
        </p>
      )}
    </div>
  )
}
