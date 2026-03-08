"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createBillingPortal } from "@/lib/api";

export function BillingCard({ firmId: propFirmId }: { firmId?: string }) {
  const searchParams = useSearchParams();
  const firmId = propFirmId || searchParams.get("firmId") || "firm_default";
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleManageBilling() {
    setLoading(true);
    setError(null);
    try {
      const url = await createBillingPortal(firmId);
      window.location.href = url;
    } catch {
      setError("Billing portal unavailable. Please contact support.");
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Billing &amp; Subscription</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-slate-600 mb-4">
          Manage your subscription, update your payment method, or cancel anytime.
        </p>
        {error && <p className="mb-3 text-sm text-rose-600">{error}</p>}
        <button
          onClick={handleManageBilling}
          disabled={loading}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
        >
          {loading ? "Redirecting…" : "Manage Billing →"}
        </button>
      </CardContent>
    </Card>
  );
}
