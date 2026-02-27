import { ArrowUpRight, CalendarCheck2, PhoneCall, PhoneMissed, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCalls } from "@/lib/api";

function metric(label: string, value: string, note: string, icon: React.ReactNode) {
  return { label, value, note, icon };
}

export default async function DashboardPage() {
  const calls = await getCalls();
  const callsToday = calls.length;
  const bookedConsults = calls.filter((call) => call.outcome.toLowerCase().includes("booked")).length;
  const missedCalls = calls.filter((call) => call.status === "missed").length;
  const conversion = callsToday > 0 ? `${Math.round((bookedConsults / callsToday) * 100)}%` : "0%";

  const metrics = [
    metric("Calls Today", `${callsToday}`, "Compared to current day volume", <PhoneCall className="h-4 w-4" />),
    metric("Booked Consults", `${bookedConsults}`, "Qualified and scheduled", <CalendarCheck2 className="h-4 w-4" />),
    metric("Missed Calls", `${missedCalls}`, "Needs callback queue review", <PhoneMissed className="h-4 w-4" />),
    metric("Conversion", conversion, "Booked consults / inbound calls", <TrendingUp className="h-4 w-4" />),
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Dashboard</h1>
        <p className="text-sm text-slate-500">Live intake visibility for calls, outcomes, and follow-up load.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map((item) => (
          <Card key={item.label}>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardDescription>{item.label}</CardDescription>
              <span className="rounded-md bg-sky-100 p-2 text-sky-700">{item.icon}</span>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold text-slate-900">{item.value}</p>
              <p className="mt-1 text-xs text-slate-500">{item.note}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Call Trend (Placeholder)</CardTitle>
            <CardDescription>Replace with backend analytics when available.</CardDescription>
          </div>
          <Badge variant="outline" className="gap-1">
            <ArrowUpRight className="h-3.5 w-3.5" />
            +12%
          </Badge>
        </CardHeader>
        <CardContent>
          <div className="grid h-56 grid-cols-12 items-end gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4">
            {[38, 52, 47, 63, 44, 70, 58, 61, 55, 77, 68, 72].map((value, index) => (
              <div
                key={index}
                className="rounded-sm bg-gradient-to-t from-sky-600 to-cyan-400"
                style={{ height: `${value}%` }}
                aria-label={`chart-bar-${index + 1}`}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
