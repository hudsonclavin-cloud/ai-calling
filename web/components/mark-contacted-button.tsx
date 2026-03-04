"use client";

import { useState } from "react";
import { CheckCheck } from "lucide-react";
import { patchLead } from "@/lib/api";

interface Props {
  leadId: string;
  contactedAt: string | null;
}

export function MarkContactedButton({ leadId, contactedAt: initialContactedAt }: Props) {
  const [contactedAt, setContactedAt] = useState(initialContactedAt);
  const [loading, setLoading] = useState(false);

  if (contactedAt) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
        <CheckCheck className="h-3.5 w-3.5" />
        Contacted {new Date(contactedAt).toLocaleDateString()}
      </span>
    );
  }

  async function handleClick() {
    setLoading(true);
    try {
      const now = new Date().toISOString();
      await patchLead(leadId, { contacted_at: now });
      setContactedAt(now);
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={loading}
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:opacity-50"
    >
      <CheckCheck className="h-3.5 w-3.5" />
      {loading ? "Saving…" : "Mark as Contacted"}
    </button>
  );
}
