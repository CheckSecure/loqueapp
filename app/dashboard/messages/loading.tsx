// Navigation loading state for the Messages route. Mirrors the existing
// in-page conversation-list skeleton (h-20 slate rows).
export default function MessagesLoading() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-10" role="status" aria-busy="true">
      <span className="sr-only">Loading messages…</span>
      <div className="animate-pulse">
        {/* Header */}
        <div className="mb-8">
          <div className="h-8 w-44 rounded-lg bg-slate-200/70" />
          <div className="mt-3 h-4 w-64 rounded bg-slate-100" />
        </div>

        {/* Conversation rows */}
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-slate-100" />
          ))}
        </div>
      </div>
    </div>
  )
}
