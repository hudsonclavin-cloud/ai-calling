"use client";

import { useEffect, useState } from "react";
import { getLeads } from "@/lib/api";
import { LeadsTable } from "@/components/leads-table";
import type { LeadSummary } from "@/lib/types";

export default function LeadsPage() {
  const [leads, setLeads] = useState<LeadSummary[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);

  useEffect(() => {
    const refresh = async () => {
      const data = await getLeads();
      setLeads(data);
      setLastUpdated(new Date());
      setSecondsAgo(0);
    };
    refresh();
    const poll = setInterval(refresh, 30_000);
    return () => clearInterval(poll);
  }, []);

  useEffect(() => {
    if (!lastUpdated) return;
    const tick = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [lastUpdated]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Leads</h1>
          <p className="mt-1 text-sm text-slate-500">All intake leads collected by Ava</p>
        </div>
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
      <LeadsTable leads={leads} />
    </div>
  );
}
