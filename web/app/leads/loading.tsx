export default function LeadsLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div>
        <div className="h-8 w-24 rounded-md bg-slate-200" />
        <div className="mt-2 h-4 w-48 rounded-md bg-slate-100" />
      </div>
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-6 py-4">
          <div className="h-5 w-24 rounded bg-slate-100" />
        </div>
        <div className="divide-y divide-slate-100">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-6 py-4">
              <div className="h-8 w-8 rounded-full bg-slate-200" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 w-32 rounded bg-slate-200" />
                <div className="h-3 w-20 rounded bg-slate-100" />
              </div>
              <div className="h-5 w-20 rounded-full bg-slate-100" />
              <div className="h-3.5 w-16 rounded bg-slate-100" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
