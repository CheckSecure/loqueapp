// Navigation loading state for the Billing route.
export default function BillingLoading() {
  return (
    <div
      className="max-w-2xl mx-auto px-4 sm:px-6 py-10 space-y-10"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">Loading billing…</span>
      <div className="animate-pulse space-y-10">
        {/* Header */}
        <div>
          <div className="h-8 w-36 rounded-lg bg-slate-200/70" />
          <div className="mt-3 h-4 w-72 rounded bg-slate-100" />
        </div>

        {/* Current plan card */}
        <div className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-sm">
          <div className="h-4 w-28 rounded bg-slate-100" />
          <div className="mt-4 h-7 w-40 rounded bg-slate-100" />
          <div className="mt-3 h-3 w-2/3 rounded bg-slate-100" />
        </div>

        {/* Plan tiers */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-sm"
            >
              <div className="h-5 w-24 rounded bg-slate-100" />
              <div className="mt-4 space-y-2.5">
                <div className="h-3 w-full rounded bg-slate-100" />
                <div className="h-3 w-5/6 rounded bg-slate-100" />
                <div className="h-3 w-4/6 rounded bg-slate-100" />
              </div>
              <div className="mt-6 h-10 w-full rounded-lg bg-slate-100" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
