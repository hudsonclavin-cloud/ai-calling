import { defaultLeadDetail, mockCalls, mockLeadDetails, mockLeads, mockSettings } from "@/lib/mock-data";
import type { CallRecord, FirmSettings, LeadDetail, LeadSummary } from "@/lib/types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:5050";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`API request failed (${response.status}) for ${path}`);
  }

  return (await response.json()) as T;
}

function unwrap<T>(payload: unknown, fallback: T): T {
  if (payload && typeof payload === "object" && "data" in payload) {
    return (payload as { data: T }).data;
  }

  return (payload as T) ?? fallback;
}

export async function getCalls(): Promise<CallRecord[]> {
  try {
    const payload = await fetchJson<CallRecord[] | { data: CallRecord[] }>("/api/calls");
    return unwrap(payload, mockCalls);
  } catch {
    return mockCalls;
  }
}

export async function getLeads(): Promise<LeadSummary[]> {
  try {
    const payload = await fetchJson<LeadSummary[] | { data: LeadSummary[] }>("/api/leads");
    return unwrap(payload, mockLeads);
  } catch {
    return mockLeads;
  }
}

export async function getLeadById(id: string): Promise<LeadDetail> {
  try {
    const payload = await fetchJson<LeadDetail | { data: LeadDetail }>(`/api/leads/${id}`);
    return unwrap(payload, defaultLeadDetail(id));
  } catch {
    return mockLeadDetails[id] ?? defaultLeadDetail(id);
  }
}

export async function getSettings(): Promise<FirmSettings> {
  try {
    const payload = await fetchJson<FirmSettings | { data: FirmSettings }>("/api/settings");
    return unwrap(payload, mockSettings);
  } catch {
    return mockSettings;
  }
}

export async function saveSettings(nextSettings: FirmSettings): Promise<FirmSettings> {
  try {
    const payload = await fetchJson<FirmSettings | { data: FirmSettings }>("/api/settings", {
      method: "POST",
      body: JSON.stringify(nextSettings),
    });

    return unwrap(payload, nextSettings);
  } catch {
    return nextSettings;
  }
}

export { API_BASE };
