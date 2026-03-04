"use client";

import { useEffect, useState } from "react";
import { Building2, PhoneCall, TrendingUp, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:5050";
const ADMIN_KEY = process.env.NEXT_PUBLIC_ADMIN_KEY ?? "";

interface FirmStat {
  id: string;
  name: string;
  billing_status: string;
  callsThisMonth: number;
  completionRate: number;
  lastCallAt: string | null;
}

interface Overview {
  totalFirms: number;
  totalLeads: number;
  totalCalls: number;
  firms: FirmStat[];
}

function timeAgo(isoString: string | null): string {
  if (!isoString) return "Never";
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function billingBadge(status: string) {
  if (status === "active") return "bg-emerald-100 text-emerald-700";
  if (status === "trialing") return "bg-sky-100 text-sky-700";
  if (status === "past_due") return "bg-rose-100 text-rose-700";
  return "bg-slate-100 text-slate-500";
}

export default function AdminPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/admin/overview`, {
      headers: ADMIN_KEY ? { "x-admin-key": ADMIN_KEY } : {},
    })
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Admin Overview</h1>
        <p className="mt-1 text-sm text-slate-500">Aggregate stats across all firms.</p>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : !data ? (
        <p className="text-sm text-rose-500">Failed to load admin overview.</p>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-sm font-medium text-slate-500">Total Firms</CardTitle>
                <Building2 className="h-4 w-4 text-slate-400" />
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-slate-900">{data.totalFirms}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-sm font-medium text-slate-500">Total Calls</CardTitle>
                <PhoneCall className="h-4 w-4 text-slate-400" />
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-slate-900">{data.totalCalls}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
                <CardTitle className="text-sm font-medium text-slate-500">Total Leads</CardTitle>
                <Users className="h-4 w-4 text-slate-400" />
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-slate-900">{data.totalLeads}</p>
              </CardContent>
            </Card>
          </div>

          {/* Per-firm table */}
          <Card>
            <CardHeader>
              <CardTitle>Firms</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-100 bg-slate-50 text-xs text-slate-500">
                  <tr>
                    <th className="px-6 py-3 text-left font-medium">Firm</th>
                    <th className="px-4 py-3 text-right font-medium">Calls (30d)</th>
                    <th className="px-4 py-3 text-right font-medium">
                      <TrendingUp className="inline h-3.5 w-3.5" /> Rate
                    </th>
                    <th className="px-4 py-3 text-left font-medium">Last Call</th>
                    <th className="px-4 py-3 text-left font-medium">Billing</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.firms.map((firm) => (
                    <tr key={firm.id} className="hover:bg-slate-50">
                      <td className="px-6 py-3.5">
                        <p className="font-medium text-slate-900">{firm.name}</p>
                        <p className="text-xs text-slate-400">{firm.id}</p>
                      </td>
                      <td className="px-4 py-3.5 text-right font-semibold text-slate-900">{firm.callsThisMonth}</td>
                      <td className="px-4 py-3.5 text-right">
                        <span className={`font-semibold ${firm.completionRate >= 70 ? "text-emerald-600" : firm.completionRate >= 40 ? "text-amber-600" : "text-slate-500"}`}>
                          {firm.completionRate}%
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-slate-500">{timeAgo(firm.lastCallAt)}</td>
                      <td className="px-4 py-3.5">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${billingBadge(firm.billing_status)}`}>
                          {firm.billing_status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.firms.length === 0 && (
                <p className="px-6 py-8 text-center text-sm text-slate-400">No firms found.</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
