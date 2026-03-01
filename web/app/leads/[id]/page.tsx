import { notFound } from "next/navigation";
import { Clock3, ScrollText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
            <Badge variant={lead.caller_type === 'returning' ? 'outline' : 'default'}>
              {lead.caller_type === 'returning' ? 'Returning Client' : 'New Client'}
            </Badge>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-sky-700" />
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
                  <p className="text-xs text-slate-500">{new Date(event.ts).toLocaleString()}</p>
                  <p className="mt-2 text-sm text-slate-700">{event.detail}</p>
                  {index !== lead.timeline.length - 1 ? <Separator className="mt-4" /> : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Case Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-700">{lead.case_summary || "No summary collected yet."}</p>
          </CardContent>
        </Card>
      </div>

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
            <div className="flex max-h-96 flex-col gap-3 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-4">
              {lead.transcript.map((entry, index) => {
                const isAssistant = entry.role === "assistant";
                return (
                  <div
                    key={index}
                    className={`flex flex-col gap-0.5 ${isAssistant ? "items-start" : "items-end"}`}
                  >
                    <span className="text-xs font-medium text-slate-400">
                      {isAssistant ? "Ava" : "Caller"}
                    </span>
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                        isAssistant
                          ? "rounded-tl-sm bg-white text-slate-700 shadow-sm ring-1 ring-slate-200"
                          : "rounded-tr-sm bg-sky-600 text-white"
                      }`}
                    >
                      {entry.text}
                    </div>
                    <span className="text-xs text-slate-400">
                      {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
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
