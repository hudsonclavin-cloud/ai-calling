import { notFound } from "next/navigation";
import { Clock3, ScrollText, Star } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { CopySummaryButton } from "@/components/copy-button";
import { MarkContactedButton } from "@/components/mark-contacted-button";
import { getLeadById } from "@/lib/api";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const lead = await getLeadById(id);

  if (!lead) {
    notFound();
  }

  const displayName = lead.full_name || lead.fromPhone || "Unknown Lead";

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">{displayName}</h1>
          <p className="text-sm text-slate-500">
            {lead.practice_area || "General"} • {lead.callback_number || lead.fromPhone}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{lead.status}</Badge>
          {lead.caller_type && (
            <Badge variant={lead.caller_type === "returning" ? "outline" : "default"}>
              {lead.caller_type === "returning" ? "Returning Client" : "New Client"}
            </Badge>
          )}
          <MarkContactedButton leadId={lead.id} contactedAt={lead.contacted_at} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Timeline */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-violet-600" />
              Timeline
            </CardTitle>
            <CardDescription>Call events and workflow milestones.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {lead.timeline.length === 0 ? (
              <p className="text-sm text-slate-500">No timeline events recorded.</p>
            ) : (
              lead.timeline.map((event, index) => (
                <div key={`${event.ts}-${index}`} className="rounded-lg border border-slate-200 p-4">
                  <p className="text-sm font-semibold text-slate-900">{event.type}</p>
                  <p className="text-xs text-slate-400">{new Date(event.ts).toLocaleString()}</p>
                  <p className="mt-2 text-sm text-slate-700">{event.detail}</p>
                  {index !== lead.timeline.length - 1 ? <Separator className="mt-4" /> : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Case Summary */}
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
            <CardTitle>Case Summary</CardTitle>
            {lead.case_summary && <CopySummaryButton text={lead.case_summary} />}
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed text-slate-700">
              {lead.case_summary || "No summary collected yet."}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* ── Quality Score ── */}
      {lead.quality_score && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Star className="h-4 w-4 text-amber-500" />
              Call Quality Score
            </CardTitle>
            <CardDescription>AI-generated quality assessment.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 sm:grid-cols-4">
              {(["naturalness", "completeness", "efficiency", "overall"] as const).map((key) => {
                const score = lead.quality_score![key];
                const color = score >= 8 ? "text-emerald-600" : score >= 5 ? "text-amber-600" : "text-rose-500";
                return (
                  <div key={key} className="rounded-lg border border-slate-200 p-4 text-center">
                    <p className={`text-3xl font-bold ${color}`}>{score}</p>
                    <p className="mt-1 text-xs font-medium capitalize text-slate-500">{key}</p>
                    <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100">
                      <div className={`h-1.5 rounded-full ${score >= 8 ? "bg-emerald-500" : score >= 5 ? "bg-amber-500" : "bg-rose-500"}`} style={{ width: `${score * 10}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            {lead.quality_score.flags.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {lead.quality_score.flags.map((flag, i) => (
                  <span key={i} className="rounded-full border border-slate-200 px-2.5 py-0.5 text-xs text-slate-500">{flag}</span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Transcript ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-slate-600" />
            Transcript
          </CardTitle>
          <CardDescription>Conversation between Ava and the caller.</CardDescription>
        </CardHeader>
        <CardContent>
          {lead.transcript.length === 0 ? (
            <p className="text-sm text-slate-500">No transcript available.</p>
          ) : (
            <div className="flex max-h-[480px] flex-col gap-4 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/50 p-4">
              {lead.transcript.map((entry, index) => {
                const isAssistant = entry.role === "assistant";
                return (
                  <div
                    key={index}
                    className={`flex items-end gap-2.5 ${isAssistant ? "flex-row" : "flex-row-reverse"}`}
                  >
                    {/* Avatar */}
                    <div
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                        isAssistant
                          ? "bg-violet-100 text-violet-700"
                          : "bg-blue-500 text-white"
                      }`}
                    >
                      {isAssistant ? "A" : "C"}
                    </div>

                    {/* Bubble */}
                    <div className={`flex max-w-[75%] flex-col gap-1 ${isAssistant ? "items-start" : "items-end"}`}>
                      <span className="text-xs font-medium text-slate-400">
                        {isAssistant ? "Ava" : "Caller"}
                      </span>
                      <div
                        className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                          isAssistant
                            ? "rounded-tl-sm bg-white text-slate-700 shadow-sm ring-1 ring-slate-200"
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
        </CardContent>
      </Card>
    </div>
  );
}
