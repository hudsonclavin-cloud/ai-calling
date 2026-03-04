import Link from "next/link";
import { Building2, Mail, Plus, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { CopySummaryButton } from "@/components/copy-button";
import { API_BASE, getFirms } from "@/lib/api";

const TONE_LABELS: Record<string, string> = {
  "warm-professional": "Warm & Professional",
  friendly: "Friendly",
  formal: "Formal",
};

export default async function ClientsPage() {
  const firms = await getFirms();

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Clients</h1>
          <p className="mt-1 text-sm text-slate-500">All firms configured in Ava.</p>
        </div>
        <Link href="/onboarding" className={buttonVariants({ size: "sm" })}>
          <Plus className="h-4 w-4" />
          Add Client
        </Link>
      </div>

      {/* ── Empty state ── */}
      {firms.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white py-16 text-slate-400">
          <Users className="h-8 w-8 opacity-40" />
          <p className="text-sm font-medium text-slate-500">No clients yet</p>
          <Link href="/onboarding" className={buttonVariants({ size: "sm", variant: "outline" })}>
            Add your first client
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {firms.map((firm) => {
            const webhookUrl = `${API_BASE}/twiml?firmId=${firm.id}`;
            const toneLabel = TONE_LABELS[firm.tone] ?? firm.tone;

            return (
              <div
                key={firm.id}
                className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                {/* ── Firm header ── */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
                      <Building2 className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="font-semibold text-slate-900">{firm.name}</p>
                      <p className="text-xs text-slate-400">
                        {firm.ava_name} · <span className="italic">{toneLabel}</span>
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline" className="shrink-0 font-mono text-xs">
                    {firm.id}
                  </Badge>
                </div>

                {/* ── Practice areas ── */}
                {firm.practice_areas?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {firm.practice_areas.map((area) => (
                      <span
                        key={area}
                        className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600"
                      >
                        {area}
                      </span>
                    ))}
                  </div>
                )}

                {/* ── Notification email ── */}
                {firm.notification_email && (
                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Mail className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                    {firm.notification_email}
                  </div>
                )}

                {/* ── Webhook URL ── */}
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <code className="flex-1 truncate text-xs text-slate-600">{webhookUrl}</code>
                    <CopySummaryButton text={webhookUrl} />
                  </div>
                  <p className="mt-1 text-[10px] text-slate-400">Twilio webhook URL</p>
                </div>

                {/* ── Actions ── */}
                <div className="flex gap-2 border-t border-slate-100 pt-1">
                  <Link
                    href={`/clients/${firm.id}/edit`}
                    className={buttonVariants({ size: "sm", variant: "outline", className: "flex-1" })}
                  >
                    Edit
                  </Link>
                  <Link
                    href={`/leads?firmId=${firm.id}`}
                    className={buttonVariants({ size: "sm", variant: "outline", className: "flex-1" })}
                  >
                    View Leads
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
