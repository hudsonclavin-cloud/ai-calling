"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Copy, Save } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { createBillingPortal, createCheckoutSession, updateFirm } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import type { FirmSettings } from "@/lib/types";

const TONES = [
  { value: "warm-professional", label: "Warm & Professional" },
  { value: "friendly", label: "Friendly & Casual" },
  { value: "formal", label: "Formal & Corporate" },
] as const;

export function FirmEditForm({
  initialFirm,
  webhookUrl,
}: {
  initialFirm: FirmSettings;
  webhookUrl: string;
}) {
  const [form, setForm] = useState(initialFirm);
  const [practiceAreasText, setPracticeAreasText] = useState(
    initialFirm.practice_areas.join(", ")
  );
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [copied, setCopied] = useState(false);
  const [billingLoading, setBillingLoading] = useState(false);

  function set<K extends keyof FirmSettings>(key: K, value: FirmSettings[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function copyWebhook() {
    await navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleBilling() {
    setBillingLoading(true);
    try {
      const url = form.stripe_customer_id
        ? await createBillingPortal(form.id)
        : await createCheckoutSession(form.id);
      window.location.href = url;
    } catch {
      setBillingLoading(false);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("saving");
    try {
      const updated: FirmSettings = {
        ...form,
        practice_areas: practiceAreasText
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
      };
      await updateFirm(form.id, updated);
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2500);
    } catch {
      setStatus("error");
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* ── Webhook URL ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-slate-500">Twilio Webhook URL</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
            <code className="flex-1 truncate text-xs text-slate-700">{webhookUrl}</code>
            <button
              type="button"
              onClick={copyWebhook}
              className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700"
              aria-label="Copy webhook URL"
            >
              {copied ? (
                <Check className="h-4 w-4 text-emerald-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </button>
          </div>
          <p className="mt-1.5 text-xs text-slate-400">
            Set this as the Voice webhook (HTTP POST) in Twilio for this client's number.
          </p>
        </CardContent>
      </Card>

      {/* ── Business info ── */}
      <Card>
        <CardHeader>
          <CardTitle>Business Info</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="name">Firm Name</Label>
            <Input
              id="name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="notification_email">Notification Email</Label>
            <Input
              id="notification_email"
              type="email"
              value={form.notification_email}
              onChange={(e) => set("notification_email", e.target.value)}
              placeholder="alerts@example.com"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="notification_phone">Notification SMS</Label>
            <Input
              id="notification_phone"
              type="tel"
              value={form.notification_phone}
              onChange={(e) => set("notification_phone", e.target.value)}
              placeholder="+14155550199"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Assistant ── */}
      <Card>
        <CardHeader>
          <CardTitle>Assistant</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="ava_name">Assistant Name</Label>
              <Input
                id="ava_name"
                value={form.ava_name}
                onChange={(e) => set("ava_name", e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tone">Tone</Label>
              <SelectNative
                id="tone"
                value={form.tone}
                onChange={(e) => set("tone", e.target.value)}
              >
                {TONES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </SelectNative>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="practice_areas">Practice Areas (comma separated)</Label>
            <Input
              id="practice_areas"
              value={practiceAreasText}
              onChange={(e) => setPracticeAreasText(e.target.value)}
              placeholder="Personal Injury, Family Law, Employment"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="max_questions">Max Questions per Call</Label>
            <Input
              id="max_questions"
              type="number"
              min={4}
              max={20}
              value={form.max_questions}
              onChange={(e) => set("max_questions", Math.max(4, Number(e.target.value)))}
              className="w-28"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Scripts ── */}
      <Card>
        <CardHeader>
          <CardTitle>Scripts</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="opening">Opening Message</Label>
            <Textarea
              id="opening"
              rows={3}
              value={form.opening}
              onChange={(e) => set("opening", e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="closing">Closing Message</Label>
            <Textarea
              id="closing"
              rows={3}
              value={form.closing}
              onChange={(e) => set("closing", e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Billing ── */}
      <Card>
        <CardHeader>
          <CardTitle>Billing</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-700">Subscription</span>
              {form.billing_status === "active" ? (
                <Badge variant="success">Active</Badge>
              ) : form.billing_status === "canceled" ? (
                <Badge variant="danger">Canceled</Badge>
              ) : form.billing_status ? (
                <Badge variant="warning">{form.billing_status}</Badge>
              ) : (
                <Badge variant="outline">Not set up</Badge>
              )}
            </div>
            <p className="text-xs text-slate-400">
              {form.stripe_customer_id
                ? "Manage your plan, invoices, and payment method."
                : "Subscribe to activate intake calls for this firm."}
            </p>
          </div>
          <Button
            type="button"
            variant={form.stripe_customer_id ? "outline" : "default"}
            disabled={billingLoading}
            onClick={handleBilling}
          >
            {billingLoading
              ? "Redirecting…"
              : form.stripe_customer_id
              ? "Manage Billing"
              : "Set Up Billing"}
          </Button>
        </CardContent>
      </Card>

      {/* ── Actions ── */}
      {status === "error" && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          Failed to save — make sure the backend is running and try again.
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"}>
          <Save className="h-4 w-4" />
          {status === "saving" ? "Saving…" : "Save Changes"}
        </Button>
        {status === "saved" && <p className="text-sm text-emerald-600">Saved.</p>}
        <Link href="/clients" className={buttonVariants({ variant: "outline", className: "ml-auto" })}>
          <ArrowLeft className="h-4 w-4" />
          Back to Clients
        </Link>
      </div>
    </form>
  );
}
