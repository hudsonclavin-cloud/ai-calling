"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SelectNative } from "@/components/ui/select-native";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CallRecord, CallStatus } from "@/lib/types";

const statusOrder: Array<CallStatus | "all"> = ["all", "answered", "missed", "voicemail"];

function statusVariant(status: CallStatus): "success" | "warning" | "danger" {
  if (status === "answered") return "success";
  if (status === "missed") return "danger";
  return "warning";
}

export function CallsTable({ calls }: { calls: CallRecord[] }) {
  const [statusFilter, setStatusFilter] = useState<(typeof statusOrder)[number]>("all");
  const [practiceAreaFilter, setPracticeAreaFilter] = useState("all");

  const practiceAreas = useMemo(() => {
    const set = new Set(calls.map((call) => call.practiceArea));
    return ["all", ...Array.from(set)];
  }, [calls]);

  const filtered = useMemo(
    () =>
      calls.filter((call) => {
        const matchesStatus = statusFilter === "all" || call.status === statusFilter;
        const matchesPractice = practiceAreaFilter === "all" || call.practiceArea === practiceAreaFilter;
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
                {status === "all" ? "All statuses" : status[0].toUpperCase() + status.slice(1)}
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
            {filtered.map((call) => (
              <TableRow key={call.id}>
                <TableCell>{new Date(call.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</TableCell>
                <TableCell className="font-medium text-slate-900">{call.caller}</TableCell>
                <TableCell>{call.practiceArea}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(call.status)}>{call.status}</Badge>
                </TableCell>
                <TableCell>{call.duration}</TableCell>
                <TableCell>{call.outcome}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
