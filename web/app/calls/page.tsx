import { CallsTable } from "@/components/calls-table";
import { getCalls } from "@/lib/api";

export default async function CallsPage() {
  const calls = await getCalls();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Calls</h1>
        <p className="text-sm text-slate-500">Monitor recent inbound call activity and intake outcomes.</p>
      </div>
      <CallsTable calls={calls} />
    </div>
  );
}
