"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SelectNative } from "@/components/ui/select-native";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { LeadSummary } from "@/lib/types";

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function statusVariant(status: string): "success" | "warning" {
  return status === "ready_for_review" ? "success" : "warning";
}

function formatStatus(status: string): string {
  if (status === "ready_for_review") return "Ready for Review";
  if (status === "in_progress") return "In Progress";
  return status;
}

export function LeadsTable({ leads }: { leads: LeadSummary[] }) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState("all");
  const [practiceAreaFilter, setPracticeAreaFilter] = useState("all");

  const practiceAreas = useMemo(() => {
    const set = new Set(leads.map((l) => l.practice_area).filter(Boolean));
    return ["all", ...Array.from(set)];
  }, [leads]);

  const filtered = useMemo(
    () =>
      leads.filter((lead) => {
        const matchesStatus = statusFilter === "all" || lead.status === statusFilter;
        const matchesPractice = practiceAreaFilter === "all" || lead.practice_area === practiceAreaFilter;
        return matchesStatus && matchesPractice;
      }),
    [leads, statusFilter, practiceAreaFilter]
  );

  return (
    <Card>
      <CardHeader className="gap-4 md:flex-row md:items-center md:justify-between">
        <CardTitle>All Leads</CardTitle>
        <div className="grid w-full gap-3 md:w-auto md:grid-cols-2">
          <SelectNative value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All statuses</option>
            <option value="ready_for_review">Ready for Review</option>
            <option value="in_progress">In Progress</option>
          </SelectNative>
          <SelectNative value={practiceAreaFilter} onChange={(e) => setPracticeAreaFilter(e.target.value)}>
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
              <TableHead>Name</TableHead>
              <TableHead>Practice Area</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Caller</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5}>
                  <div className="flex flex-col items-center justify-center gap-2 py-16 text-slate-400">
                    <Users className="h-8 w-8 opacity-40" />
                    <p className="text-sm font-medium text-slate-500">No leads found</p>
                    <p className="text-xs">
                      {statusFilter !== "all" || practiceAreaFilter !== "all"
                        ? "Try adjusting your filters"
                        : "Leads will appear here after intake calls"}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((lead) => (
                <TableRow
                  key={lead.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => router.push(`/leads/${lead.id}`)}
                >
                  <TableCell className="font-medium text-slate-900">
                    {lead.full_name || lead.fromPhone || "—"}
                  </TableCell>
                  <TableCell>{lead.practice_area || "—"}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(lead.status)}>{formatStatus(lead.status)}</Badge>
                  </TableCell>
                  <TableCell>
                    {lead.caller_type ? (
                      <Badge variant={lead.caller_type === "returning" ? "outline" : "default"}>
                        {lead.caller_type === "returning" ? "Returning" : "New"}
                      </Badge>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-slate-500">{timeAgo(lead.createdAt)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
