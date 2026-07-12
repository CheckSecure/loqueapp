// Navigation loading state for the Introductions route.
export default function IntroductionsLoading() {
  return (
    <div
      className="relative min-h-screen bg-[#FAF6EE] p-4 md:p-8 pt-20 md:pt-8 pb-24 md:pb-8"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">Loading introductions…</span>
      <div className="max-w-4xl animate-pulse">
        {/* Header */}
        <div className="mb-10">
          <div className="h-8 w-56 rounded-lg bg-slate-200/70" />
          <div className="mt-3 h-4 w-80 rounded bg-slate-100" />
        </div>

        {/* Introduction cards */}
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-2xl border border-slate-200/70 bg-white p-6 shadow-sm"
            >
              <div className="flex items-start gap-4">
                <div className="h-14 w-14 flex-shrink-0 rounded-full bg-slate-100" />
                <div className="flex-1 space-y-3">
                  <div className="h-4 w-2/5 rounded bg-slate-100" />
                  <div className="h-3 w-3/5 rounded bg-slate-100" />
                  <div className="h-3 w-1/2 rounded bg-slate-100" />
                </div>
              </div>
              <div className="mt-5 flex gap-3">
                <div className="h-9 w-28 rounded-lg bg-slate-100" />
                <div className="h-9 w-28 rounded-lg bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
