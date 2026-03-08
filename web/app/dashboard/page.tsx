"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpRight, CalendarCheck2, PhoneCall, PhoneMissed, Plus, TrendingUp, Users, AlertCircle, Voicemail } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { getCalls, getLeads, getHealth, getAnalytics } from "@/lib/api";
import type { HealthData } from "@/lib/api";
import type { AnalyticsData, CallRecord, LeadSummary } from "@/lib/types";

function timeAgo(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1"))
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  if (digits.length === 10)
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return phone;
}

const METRIC_COLORS = ["border-l-blue-500", "border-l-emerald-500", "border-l-amber-500", "border-l-violet-500"];
const METRIC_ICON_COLORS = ["bg-blue-50 text-blue-600", "bg-emerald-50 text-emerald-600", "bg-amber-50 text-amber-600", "bg-violet-50 text-violet-600"];

function statusBadgeClass(status: string): string {
  if (status === "completed" || status === "ready_for_review") return "bg-emerald-100 text-emerald-700";
  if (status === "partial") return "bg-amber-100 text-amber-700";
  if (status === "failed") return "bg-rose-100 text-rose-700";
  if (status === "voicemail") return "bg-violet-100 text-violet-700";
  return "bg-slate-100 text-slate-600";
}

function CallsSparkline({ data }: { data: { date: string; count: number }[] | null; calls: CallRecord[] }) {
  // Prefer analytics data; fall back to computing from raw calls
  const counts = data
    ? data.slice(-7).map((d) => d.count)
    : Array.from({ length: 7 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (6 - i));
        return 0; // placeholder when no data
      });
  const labels = (data ? data.slice(-7) : []).map((d) =>
    new Date(d.date).toLocaleDateString([], { weekday: "short" })
  );
  const max = Math.max(...counts, 1);

  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">Calls — Last 7 Days</p>
      <div className="flex items-end gap-1.5 h-14">
        {counts.map((count, i) => (
          <div key={i} className="flex flex-1 flex-col items-center gap-1">
            <div
              className="w-full rounded-sm bg-sky-500 transition-all"
              style={{ height: `${Math.max((count / max) * 48, count > 0 ? 4 : 0)}px` }}
              title={`${labels[i] ?? `Day ${i + 1}`}: ${count} call${count !== 1 ? "s" : ""}`}
            />
            <span className="text-[9px] text-slate-400">{labels[i] ?? ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PracticeAreaChart({ areas }: { areas: { area: string; count: number }[] }) {
  if (!areas.length) return null;
  const max = areas[0].count;
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-slate-500">Top Practice Areas</p>
      <div className="space-y-2">
        {areas.map(({ area, count }) => (
          <div key={area} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-xs text-slate-600">{area}</span>
            <div className="flex-1 rounded-full bg-slate-100 h-2">
              <div
                className="h-2 rounded-full bg-violet-500 transition-all"
                style={{ width: `${(count / max) * 100}%` }}
              />
            </div>
            <span className="w-6 text-right text-xs text-slate-400">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LiveDot() {
  return (
    <span className="flex items-center gap-1.5 text-xs text-emerald-600">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      Live
    </span>
  );
}

export default function DashboardPage() {
  const searchParams = useSearchParams();
  const firmId = searchParams.get("firmId");
  const q = firmId ? `?firmId=${firmId}` : "";
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [leads, setLeads] = useState<LeadSummary[]>([]);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);

  async function refresh() {
    const [c, l, h, a] = await Promise.all([getCalls(), getLeads(), getHealth(), getAnalytics("firm_default", 30)]);
    setCalls(c);
    setLeads(l);
    setHealth(h);
    setAnalytics(a);
    setLastUpdated(new Date());
    setSecondsAgo(0);
  }

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 30_000);
    return () => clearInterval(poll);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!lastUpdated) return;
    const tick = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(tick);
  }, [lastUpdated]);

  const totalCalls = analytics?.totalCalls ?? calls.length;
  const completedIntakes = analytics?.completed ?? calls.filter((c) => c.outcome === "intake_complete").length;
  const inProgress = calls.filter((c) => c.status === "in_progress").length;
  const conversionRate = analytics?.completionRate ?? (totalCalls > 0 ? Math.round((completedIntakes / totalCalls) * 100) : 0);
  const todayStr = new Date().toISOString().slice(0, 10);
  const callsToday = analytics
    ? (analytics.callsByDay.find((d) => d.date === todayStr)?.count ?? 0)
    : calls.filter((c) => new Date(c.startedAt).toISOString().slice(0, 10) === todayStr).length;
  const yesterdayStr = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const callsYesterday = analytics?.callsByDay.find((d) => d.date === yesterdayStr)?.count ?? 0;
  const todayDelta = callsToday - callsYesterday;
  const partialLeads = analytics?.partial ?? leads.filter((l) => l.status === "partial").length;
  const voicemailLeads = analytics?.voicemails ?? leads.filter((l) => l.status === "voicemail").length;

  const metrics = [
    { label: "Total Calls", value: `${totalCalls}`, note: "All inbound calls on record", icon: <PhoneCall className="h-4 w-4" /> },
    { label: "Completed Intakes", value: `${completedIntakes}`, note: "Full intake collected", icon: <CalendarCheck2 className="h-4 w-4" /> },
    { label: "In Progress", value: `${inProgress}`, note: "Active or incomplete", icon: <PhoneMissed className="h-4 w-4" /> },
    { label: "Completion Rate", value: `${conversionRate}%`, note: "Completed / inbound", icon: <TrendingUp className="h-4 w-4" /> },
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
        <div className="flex items-center gap-3">
          {health && (
            <span className="hidden items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              System healthy
            </span>
          )}
          {lastUpdated && (
            <span className="hidden items-center gap-2 sm:flex">
              <LiveDot />
              <span className="text-xs text-slate-400">
                Updated {secondsAgo < 5 ? "just now" : `${secondsAgo}s ago`}
              </span>
            </span>
          )}
          <Link href="/onboarding" className={buttonVariants({ size: "sm" })}>
            <Plus className="h-4 w-4" />
            Add Client
          </Link>
        </div>
      </div>

      {/* ── Metric cards ── */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map((item, i) => (
          <div key={item.label} className={`rounded-xl border border-slate-200 border-l-4 bg-white shadow-sm ${METRIC_COLORS[i]}`}>
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
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <div className="flex items-center gap-2 text-slate-500">
            <Users className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-wide">Total Leads</span>
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900">{leads.length}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <div className="flex items-center gap-2 text-amber-500">
            <AlertCircle className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-wide">Partial</span>
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900">{partialLeads}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <div className="flex items-center gap-2 text-violet-500">
            <Voicemail className="h-4 w-4" />
            <span className="text-xs font-medium uppercase tracking-wide">Voicemails</span>
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900">{voicemailLeads}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-slate-500">
              <PhoneCall className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-wide">Today</span>
            </div>
            {todayDelta !== 0 && (
              <span className={`flex items-center gap-0.5 text-xs font-medium ${todayDelta > 0 ? "text-emerald-600" : "text-rose-500"}`}>
                {todayDelta > 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                {Math.abs(todayDelta)}
              </span>
            )}
          </div>
          <p className="mt-2 text-2xl font-bold text-slate-900">{callsToday}</p>
        </div>
      </div>

      {/* ── Charts row ── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <CallsSparkline data={analytics?.callsByDay ?? null} calls={calls} />
        <PracticeAreaChart areas={analytics?.topPracticeAreas ?? []} />
      </div>

      {/* ── Recent activity feed ── */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Recent Activity</h2>
            <p className="text-xs text-slate-500">Last {recentActivity.length} calls</p>
          </div>
          <Link href={`/calls${q}`} className="flex items-center gap-1 text-xs font-medium text-violet-600 hover:text-violet-700">
            View all <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {recentActivity.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400">
            <PhoneCall className="mb-3 h-8 w-8 opacity-40" />
            <p className="text-sm font-medium">No calls recorded yet</p>
            <p className="mt-1 text-xs">Calls will appear here as they come in</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {recentActivity.map((call) => (
              <li key={call.id}>
                <Link href={`/leads/${call.leadId}${q}`} className="flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-slate-50">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
                    {(call.collected?.full_name || call.fromPhone || "?").charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-900">
                      {call.collected?.full_name || formatPhone(call.fromPhone)}
                    </p>
                    <p className="text-xs text-slate-400">
                      {call.collected?.practice_area || "Unknown area"} • {formatPhone(call.fromPhone)}
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadgeClass(call.status as string)}`}>
                    {call.status === "completed" ? "Completed" : "In Progress"}
                  </span>
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
