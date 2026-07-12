// Navigation loading state for the Network route.
export default function NetworkLoading() {
  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8" role="status" aria-busy="true">
      <span className="sr-only">Loading your network…</span>
      <div className="max-w-4xl animate-pulse">
        {/* Header */}
        <div className="mb-10">
          <div className="h-8 w-44 rounded-lg bg-slate-200/70" />
          <div className="mt-3 h-4 w-72 rounded bg-slate-100" />
        </div>

        {/* Connection grid */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="rounded-2xl border border-slate-200/70 bg-white p-5 shadow-sm"
            >
              <div className="flex items-center gap-4">
                <div className="h-14 w-14 flex-shrink-0 rounded-full bg-slate-100" />
                <div className="flex-1 space-y-2.5">
                  <div className="h-4 w-2/3 rounded bg-slate-100" />
                  <div className="h-3 w-1/2 rounded bg-slate-100" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
