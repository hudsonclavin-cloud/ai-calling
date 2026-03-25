"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { getLeads } from "@/lib/api";
import { LeadsTable } from "@/components/leads-table";
import type { LeadSummary } from "@/lib/types";

function toCSV(leads: LeadSummary[]): string {
  const headers = ["Date", "Name", "Phone", "Callback Number", "Practice Area", "Case Summary", "Calling For", "Status", "Partial", "Contacted", "Caller Type"];
  const rows = leads.map((l) => [
    new Date(l.createdAt).toLocaleDateString(),
    l.full_name || "",
    l.fromPhone || "",
    l.callback_number || "",
    l.practice_area || "",
    (l.case_summary || "").replace(/"/g, '""'),
    l.calling_for || "",
    l.status || "",
    l.status === "partial" ? "Yes" : "No",
    l.contacted_at ? new Date(l.contacted_at).toLocaleDateString() : "",
    l.caller_type || "",
  ]);
  return [headers, ...rows].map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<LeadSummary[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [exportMsg, setExportMsg] = useState("");
  const exportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('firmId') ?? '';

    const doRefresh = async () => {
      const data = await getLeads(id);
      setLeads(data);
      setLastUpdated(new Date());
      setSecondsAgo(0);
    };
    doRefresh();
    const poll = setInterval(doRefresh, 10_000);
    return () => clearInterval(poll);
  }, []);

  useEffect(() => {
    if (!lastUpdated) return;
    const tick = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [lastUpdated]);

  function handleExport() {
    if (!leads.length) return;
    const csv = toCSV(leads);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setExportMsg(`Exported ${leads.length} lead${leads.length !== 1 ? "s" : ""}`);
    if (exportTimerRef.current) clearTimeout(exportTimerRef.current);
    exportTimerRef.current = setTimeout(() => setExportMsg(""), 3000);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Leads</h1>
          <p className="mt-1 text-sm text-slate-500">All intake leads collected by Ava</p>
        </div>
        <div className="flex items-center gap-3">
          {exportMsg && <span className="text-xs text-emerald-600">{exportMsg}</span>}
          <button
            onClick={handleExport}
            disabled={!leads.length}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
          {lastUpdated && (
            <span className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Updated {secondsAgo < 5 ? "just now" : `${secondsAgo}s ago`}
            </span>
          )}
        </div>
      </div>
      <Suspense>
        <LeadsTable leads={leads} />
      </Suspense>
    </div>
  );
}
