"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import Link from "next/link";
import { getLeadById } from "@/lib/api";
import type { LeadDetail } from "@/lib/types";

interface TranscriptPanelProps {
  leadId: string | null;
  onClose: () => void;
}

export function TranscriptPanel({ leadId, onClose }: TranscriptPanelProps) {
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!leadId) {
      setLead(null);
      return;
    }
    setLoading(true);
    setLead(null);
    getLeadById(leadId).then((data) => {
      setLead(data);
      setLoading(false);
    });
  }, [leadId]);

  if (!leadId) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-96 flex-col border-l border-slate-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Call Transcript</h2>
            {lead && (
              <p className="mt-0.5 text-xs text-slate-500">
                {lead.full_name || lead.fromPhone || "Unknown"}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-200 border-t-violet-600" />
            </div>
          ) : !lead?.transcript?.length ? (
            <p className="py-12 text-center text-sm text-slate-400">No transcript available.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {lead.transcript.map((entry, index) => {
                const isAssistant = entry.role === "assistant";
                return (
                  <div
                    key={index}
                    className={`flex items-end gap-2 ${isAssistant ? "flex-row" : "flex-row-reverse"}`}
                  >
                    <div
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        isAssistant ? "bg-violet-100 text-violet-700" : "bg-blue-500 text-white"
                      }`}
                    >
                      {isAssistant ? "A" : "C"}
                    </div>
                    <div className={`flex max-w-[78%] flex-col gap-0.5 ${isAssistant ? "items-start" : "items-end"}`}>
                      <div
                        className={`rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                          isAssistant
                            ? "rounded-tl-sm bg-slate-100 text-slate-700"
                            : "rounded-tr-sm bg-blue-50 text-slate-800 ring-1 ring-blue-100"
                        }`}
                      >
                        {entry.text}
                      </div>
                      <span className="text-xs text-slate-400">
                        {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {lead && (
          <div className="border-t border-slate-200 px-5 py-4">
            <Link
              href={`/leads/${lead.id}`}
              className="text-sm font-medium text-violet-600 hover:text-violet-700"
              onClick={onClose}
            >
              View full details →
            </Link>
          </div>
        )}
      </div>
    </>
  );
}
