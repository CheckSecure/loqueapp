// Navigation loading state for the Settings route.
export default function SettingsLoading() {
  return (
    <div
      className="max-w-2xl mx-auto px-4 sm:px-6 py-10 sm:py-12 space-y-6 sm:space-y-8"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">Loading settings…</span>
      <div className="animate-pulse space-y-6 sm:space-y-8">
        {/* Header */}
        <div>
          <div className="h-8 w-40 rounded-lg bg-slate-200/70" />
          <div className="mt-3 h-4 w-64 rounded bg-slate-100" />
        </div>

        {/* Settings section cards */}
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-sm"
          >
            <div className="h-4 w-1/3 rounded bg-slate-100" />
            <div className="mt-4 space-y-3">
              <div className="h-10 w-full rounded-lg bg-slate-100" />
              <div className="h-10 w-full rounded-lg bg-slate-100" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
