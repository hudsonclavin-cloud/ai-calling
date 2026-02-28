"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SelectNative } from "@/components/ui/select-native";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CallRecord, CallStatus } from "@/lib/types";

const statusOrder: Array<CallStatus | "all"> = ["all", "in_progress", "completed"];

function statusVariant(status: CallStatus): "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  return "warning";
}

function formatDuration(startedAt: string, endedAt: string | null): string {
  if (!endedAt) return "—";
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0) return "—";
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatOutcome(outcome: string): string {
  if (outcome === "intake_complete") return "Intake Complete";
  if (!outcome) return "—";
  return outcome;
}

function formatStatus(status: CallStatus): string {
  if (status === "in_progress") return "In Progress";
  return "Completed";
}

export function CallsTable({ calls }: { calls: CallRecord[] }) {
  const [statusFilter, setStatusFilter] = useState<(typeof statusOrder)[number]>("all");
  const [practiceAreaFilter, setPracticeAreaFilter] = useState("all");

  const practiceAreas = useMemo(() => {
    const set = new Set(calls.map((call) => call.collected?.practice_area || "").filter(Boolean));
    return ["all", ...Array.from(set)];
  }, [calls]);

  const filtered = useMemo(
    () =>
      calls.filter((call) => {
        const matchesStatus = statusFilter === "all" || call.status === statusFilter;
        const matchesPractice =
          practiceAreaFilter === "all" || (call.collected?.practice_area || "") === practiceAreaFilter;
        return matchesStatus && matchesPractice;
      }),
    [calls, statusFilter, practiceAreaFilter]
  );

  return (
    <Card>
      <CardHeader className="gap-4 md:flex-row md:items-center md:justify-between">
        <CardTitle>Recent Calls</CardTitle>
        <div className="grid w-full gap-3 md:w-auto md:grid-cols-2">
          <SelectNative value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as (typeof statusOrder)[number])}>
            {statusOrder.map((status) => (
              <option key={status} value={status}>
                {status === "all" ? "All statuses" : formatStatus(status as CallStatus)}
              </option>
            ))}
          </SelectNative>
          <SelectNative value={practiceAreaFilter} onChange={(event) => setPracticeAreaFilter(event.target.value)}>
            {practiceAreas.map((area) => (
              <option key={area} value={area}>
                {area === "all" ? "All practice areas" : area}
              </option>
            ))}
          </SelectNative>
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Caller</TableHead>
              <TableHead>Practice Area</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-sm text-slate-500">
                  No calls to display.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((call) => (
                <TableRow key={call.id}>
                  <TableCell>
                    {new Date(call.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </TableCell>
                  <TableCell className="font-medium text-slate-900">
                    {call.collected?.full_name || call.fromPhone}
                  </TableCell>
                  <TableCell>{call.collected?.practice_area || "—"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(call.status)}>{formatStatus(call.status)}</Badge>
                  </TableCell>
                  <TableCell>{formatDuration(call.startedAt, call.endedAt)}</TableCell>
                  <TableCell>{formatOutcome(call.outcome)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
