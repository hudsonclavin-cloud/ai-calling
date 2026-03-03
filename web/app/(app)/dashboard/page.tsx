import Link from "next/link";
import { ArrowUpRight, CalendarCheck2, PhoneCall, PhoneMissed, Plus, TrendingUp, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getCalls, getLeads } from "@/lib/api";

function timeAgo(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

const METRIC_COLORS = [
  "border-l-blue-500",
  "border-l-emerald-500",
  "border-l-amber-500",
  "border-l-violet-500",
];

const METRIC_ICON_COLORS = [
  "bg-blue-50 text-blue-600",
  "bg-emerald-50 text-emerald-600",
  "bg-amber-50 text-amber-600",
  "bg-violet-50 text-violet-600",
];

export default async function DashboardPage() {
  const [calls, leads] = await Promise.all([getCalls(), getLeads()]);

  const totalCalls = calls.length;
  const completedIntakes = calls.filter((c) => c.outcome === "intake_complete").length;
  const inProgress = calls.filter((c) => c.status === "in_progress").length;
  const conversionRate = totalCalls > 0 ? Math.round((completedIntakes / totalCalls) * 100) : 0;

  const todayStr = new Date().toDateString();
  const callsToday = calls.filter((c) => new Date(c.startedAt).toDateString() === todayStr).length;

  const metrics = [
    { label: "Total Calls", value: `${totalCalls}`, note: "All inbound calls on record", icon: <PhoneCall className="h-4 w-4" /> },
    { label: "Completed Intakes", value: `${completedIntakes}`, note: "Full intake collected", icon: <CalendarCheck2 className="h-4 w-4" /> },
    { label: "In Progress", value: `${inProgress}`, note: "Active or incomplete", icon: <PhoneMissed className="h-4 w-4" /> },
    { label: "Conversion", value: `${conversionRate}%`, note: "Completed / inbound", icon: <TrendingUp className="h-4 w-4" /> },
  ];

  const recentActivity = calls
    .slice()
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 8);

  return (
    <div className="space-y-8">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-500">Live intake visibility for calls, outcomes, and lead status.</p>
        </div>
        <Link href="/onboarding" className={buttonVariants({ size: "sm" })}>
          <Plus className="h-4 w-4" />
          Add Client
        </Link>
      </div>

      {/* ── Metric cards ── */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map((item, i) => (
          <div
            key={item.label}
            className={`rounded-xl border border-slate-200 border-l-4 bg-white shadow-sm ${METRIC_COLORS[i]}`}
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-1">
              <p className="text-sm font-medium text-slate-500">{item.label}</p>
              <span className={`rounded-lg p-2 ${METRIC_ICON_COLORS[i]}`}>{item.icon}</span>
            </div>
            <div className="px-5 pb-4">
              <p className="text-3xl font-bold text-slate-900">{item.value}</p>
              <p className="mt-0.5 text-xs text-slate-400">{item.note}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Quick stats row ── */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <div className="flex items-center gap-2 text-slate-500">
            <Users className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-wide">Total Leads</span>
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900">{leads.length}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <div className="flex items-center gap-2 text-slate-500">
            <TrendingUp className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-wide">Completion Rate</span>
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900">{conversionRate}%</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <div className="flex items-center gap-2 text-slate-500">
            <PhoneCall className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-wide">Calls Today</span>
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900">{callsToday}</p>
        </div>
      </div>

      {/* ── Recent activity feed ── */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Recent Activity</h2>
            <p className="text-xs text-slate-500">Last {recentActivity.length} calls</p>
          </div>
          <Link
            href="/calls"
            className="flex items-center gap-1 text-xs font-medium text-violet-600 hover:text-violet-700"
          >
            View all <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {recentActivity.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400">
            <PhoneCall className="h-8 w-8 mb-3 opacity-40" />
            <p className="text-sm font-medium">No calls recorded yet</p>
            <p className="text-xs mt-1">Calls will appear here as they come in</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {recentActivity.map((call) => (
              <li key={call.id}>
                <Link
                  href={`/leads/${call.leadId}`}
                  className="flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-slate-50"
                >
                  {/* Avatar */}
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
                    {(call.collected?.full_name || call.fromPhone || "?").charAt(0).toUpperCase()}
                  </div>

                  {/* Caller info */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {call.collected?.full_name || formatPhone(call.fromPhone)}
                    </p>
                    <p className="text-xs text-slate-400">
                      {call.collected?.practice_area || "Unknown area"} • {formatPhone(call.fromPhone)}
                    </p>
                  </div>

                  {/* Status badge */}
                  <Badge
                    variant={call.status === "completed" ? "success" : "warning"}
                    className="shrink-0 text-xs"
                  >
                    {call.status === "completed" ? "Completed" : "In Progress"}
                  </Badge>

                  {/* Time ago */}
                  <span className="shrink-0 text-xs text-slate-400">{timeAgo(call.startedAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
