// Navigation loading state for the Meetings route.
export default function MeetingsLoading() {
  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8" role="status" aria-busy="true">
      <span className="sr-only">Loading meetings…</span>
      <div className="max-w-3xl animate-pulse">
        {/* Header */}
        <div className="mb-10 flex items-center justify-between">
          <div>
            <div className="h-8 w-40 rounded-lg bg-slate-200/70" />
            <div className="mt-3 h-4 w-64 rounded bg-slate-100" />
          </div>
          <div className="h-8 w-32 rounded-lg bg-slate-100" />
        </div>

        {/* Meeting cards */}
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-slate-200/70 bg-white p-5 shadow-sm"
            >
              <div className="flex items-start gap-3">
                <div className="h-9 w-9 flex-shrink-0 rounded-lg bg-slate-100" />
                <div className="flex-1 space-y-2.5">
                  <div className="h-4 w-1/2 rounded bg-slate-100" />
                  <div className="h-3 w-2/3 rounded bg-slate-100" />
                </div>
                <div className="h-10 w-10 flex-shrink-0 rounded-full bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
