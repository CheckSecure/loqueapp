// Navigation loading state for the Profile route.
export default function ProfileLoading() {
  return (
    <div className="p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8" role="status" aria-busy="true">
      <span className="sr-only">Loading your profile…</span>
      <div className="max-w-2xl animate-pulse">
        {/* Header */}
        <div className="mb-10">
          <div className="h-8 w-40 rounded-lg bg-slate-200/70" />
          <div className="mt-3 h-4 w-64 rounded bg-slate-100" />
        </div>

        {/* Profile form card */}
        <div className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-sm">
          {/* Avatar row */}
          <div className="mb-8 flex items-center gap-4">
            <div className="h-20 w-20 flex-shrink-0 rounded-full bg-slate-100" />
            <div className="space-y-2.5">
              <div className="h-4 w-40 rounded bg-slate-100" />
              <div className="h-3 w-28 rounded bg-slate-100" />
            </div>
          </div>

          {/* Field rows */}
          <div className="space-y-6">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-24 rounded bg-slate-100" />
                <div className="h-10 w-full rounded-lg bg-slate-100" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
