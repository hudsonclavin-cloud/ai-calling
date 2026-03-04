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
    return unwrap(payload, []);
  } catch {
    return [];
  }
}

export async function getLeads(): Promise<LeadSummary[]> {
  try {
    const payload = await fetchJson<LeadSummary[] | { data: LeadSummary[] }>("/api/leads");
    return unwrap(payload, []);
  } catch {
    return [];
  }
}

export async function getLeadById(id: string): Promise<LeadDetail | null> {
  try {
    const payload = await fetchJson<LeadDetail | { data: LeadDetail }>(`/api/leads/${id}`);
    return unwrap(payload, null);
  } catch {
    return null;
  }
}

export async function getSettings(): Promise<FirmSettings | null> {
  try {
    const payload = await fetchJson<FirmSettings | { data: FirmSettings }>("/api/firms/firm_default");
    return unwrap(payload, null);
  } catch {
    return null;
  }
}

export async function getFirms(): Promise<FirmSettings[]> {
  try {
    const payload = await fetchJson<FirmSettings[] | { data: FirmSettings[] }>("/api/firms");
    return unwrap(payload, []);
  } catch {
    return [];
  }
}

export async function updateFirm(id: string, config: Partial<FirmSettings>): Promise<FirmSettings> {
  const payload = await fetchJson<FirmSettings | { data: FirmSettings }>(`/api/firms/${id}`, {
    method: "POST",
    body: JSON.stringify({ ...config, id }),
  });
  return unwrap(payload, config as FirmSettings);
}

export async function createFirm(id: string, config: Partial<FirmSettings>): Promise<FirmSettings> {
  const payload = await fetchJson<FirmSettings | { data: FirmSettings }>(`/api/firms/${id}`, {
    method: "POST",
    body: JSON.stringify(config),
  });
  return unwrap(payload, config as FirmSettings);
}

export async function saveSettings(nextSettings: FirmSettings): Promise<FirmSettings> {
  try {
    const firmId = nextSettings.id ?? "firm_default";
    const payload = await fetchJson<FirmSettings | { data: FirmSettings }>(`/api/firms/${firmId}`, {
      method: "POST",
      body: JSON.stringify(nextSettings),
    });

    return unwrap(payload, nextSettings);
  } catch {
    return nextSettings;
  }
}

export async function createCheckoutSession(firmId: string, fromSignup = false): Promise<string> {
  const payload = await fetchJson<{ url: string }>("/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ firmId, fromSignup }),
  });
  return payload.url;
}

export async function patchLead(id: string, updates: { contacted_at?: string; status?: string }): Promise<void> {
  await fetchJson(`/api/leads/${id}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function sendSetupInstructions(firmId: string): Promise<void> {
  await fetchJson("/api/resend-instructions", {
    method: "POST",
    body: JSON.stringify({ firmId }),
  });
}

export async function testWebhook(firmId: string): Promise<{ ok: boolean; status: number; body: string }> {
  return fetchJson("/api/test-webhook", { method: "POST", body: JSON.stringify({ firmId }) });
}

export async function createBillingPortal(firmId: string): Promise<string> {
  const payload = await fetchJson<{ url: string }>("/api/billing/portal", {
    method: "POST",
    body: JSON.stringify({ firmId }),
  });
  return payload.url;
}

export interface HealthData {
  status: string;
  uptime: number;
  activeSessions: number;
  totalLeads: number;
  version: string;
  timestamp: string;
}

export async function getHealth(): Promise<HealthData | null> {
  try {
    return await fetchJson<HealthData>("/health");
  } catch {
    return null;
  }
}

export { API_BASE };
