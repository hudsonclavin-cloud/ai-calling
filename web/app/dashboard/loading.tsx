export default function DashboardLoading() {
  return (
    <div className="space-y-8 animate-pulse">
      <div>
        <div className="h-8 w-48 rounded-md bg-slate-200" />
        <div className="mt-2 h-4 w-64 rounded-md bg-slate-100" />
      </div>
      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="mb-3 h-3.5 w-24 rounded bg-slate-100" />
            <div className="h-8 w-16 rounded bg-slate-200" />
          </div>
        ))}
      </div>
      {/* Chart skeleton */}
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="mb-4 h-5 w-32 rounded bg-slate-100" />
        <div className="h-48 rounded bg-slate-100" />
      </div>
    </div>
  );
}
