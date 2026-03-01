import { getLeads } from "@/lib/api";
import { LeadsTable } from "@/components/leads-table";

export default async function LeadsPage() {
  const leads = await getLeads();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Leads</h1>
        <p className="mt-1 text-sm text-slate-500">All intake leads collected by Ava</p>
      </div>
      <LeadsTable leads={leads} />
    </div>
  );
}
