// Navigation loading state for the Opportunities route.
export default function OpportunitiesLoading() {
  return (
    <div
      className="mx-auto max-w-4xl px-4 sm:px-6 py-8 sm:py-10"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">Loading opportunities…</span>
      <div className="animate-pulse">
        {/* Header */}
        <div className="mb-10">
          <div className="h-8 w-52 rounded-lg bg-slate-200/70" />
          <div className="mt-3 h-4 w-80 rounded bg-slate-100" />
        </div>

        {/* Opportunity cards */}
        <div className="space-y-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-sm"
            >
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="h-6 w-24 rounded-full bg-slate-100" />
                  <div className="h-4 w-1/3 rounded bg-slate-100" />
                </div>
                <div className="h-3 w-full rounded bg-slate-100" />
                <div className="h-3 w-4/5 rounded bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
