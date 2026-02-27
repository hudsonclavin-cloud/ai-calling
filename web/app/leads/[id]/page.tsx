import { notFound } from "next/navigation";
import { Clock3, Lightbulb, ScrollText } from "lucide-react";

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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">{lead.caller}</h1>
          <p className="text-sm text-slate-500">
            {lead.practiceArea} • {lead.phone} • {lead.email}
          </p>
        </div>
        <Badge variant="outline">{lead.status}</Badge>
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
            {lead.timeline.map((event, index) => (
              <div key={event.id} className="rounded-lg border border-slate-200 p-4">
                <p className="text-sm font-semibold text-slate-900">{event.type}</p>
                <p className="text-xs text-slate-500">{new Date(event.timestamp).toLocaleString()}</p>
                <p className="mt-2 text-sm text-slate-700">{event.description}</p>
                {index !== lead.timeline.length - 1 ? <Separator className="mt-4" /> : null}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lightbulb className="h-4 w-4 text-amber-600" />
              Suggested next action
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-700">{lead.suggestedNextAction}</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-slate-700">{lead.summary}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-slate-600" />
              Transcript Viewer
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-xs text-slate-700">
              {lead.transcript}
            </pre>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
