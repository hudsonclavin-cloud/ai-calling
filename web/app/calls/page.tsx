"use client";

import { useEffect, useState } from "react";
import { CallsTable } from "@/components/calls-table";
import { getCalls } from "@/lib/api";
import type { CallRecord } from "@/lib/types";

export default function CallsPage() {
  const [calls, setCalls] = useState<CallRecord[]>([]);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('firmId') ?? '';

    const doRefresh = async () => {
      const data = await getCalls(id);
      setCalls(data);
    };

    doRefresh();
    const poll = setInterval(doRefresh, 10_000);
    return () => clearInterval(poll);
  }, []);

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
