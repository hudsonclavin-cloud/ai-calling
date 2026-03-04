"use client";

import { useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Save, Volume2, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { saveSettings, testWebhook } from "@/lib/api";
import type { FirmSettings } from "@/lib/types";

const TONES = ["Professional", "Warm", "Concise", "Friendly", "Formal"];

const API_BASE_CLIENT = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:5050";

const API_BASE = API_BASE_CLIENT;

function WebhookCopyField({ firmId }: { firmId: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${API_BASE}/twiml?firmId=${firmId}`;

  async function handleCopy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex items-center gap-2">
      <Input value={url} readOnly className="font-mono text-xs text-slate-500" />
      <button
        onClick={handleCopy}
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied!" : "Copy"}
      </button>
      <a
        href="https://console.twilio.com"
        target="_blank"
        rel="noopener noreferrer"
        className="flex shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700"
      >
        <ExternalLink className="h-3.5 w-3.5" />
        Twilio
      </a>
    </div>
  );
}

function VoicePreviewButton({ firmId }: { firmId: string }) {
  const [playing, setPlaying] = useState(false);

  async function handlePlay() {
    if (playing) return;
    setPlaying(true);
    try {
      const url = `${API_BASE_CLIENT}/api/voice-preview?firmId=${encodeURIComponent(firmId)}`;
      const audio = new Audio(url);
      audio.onended = () => setPlaying(false);
      audio.onerror = () => setPlaying(false);
      await audio.play();
    } catch {
      setPlaying(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handlePlay}
      disabled={playing}
      className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700 disabled:opacity-50"
    >
      <Volume2 className="h-3.5 w-3.5" />
      {playing ? (
        <span className="flex items-center gap-1">
          <span className="flex gap-0.5">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="inline-block w-0.5 rounded-full bg-violet-500"
                style={{ height: "12px", animation: `bounce 0.8s ${i * 0.15}s infinite alternate` }}
              />
            ))}
          </span>
          Playing…
        </span>
      ) : "Preview Voice"}
    </button>
  );
}

function WebhookDeliveryField({ firmId, webhookUrl, onChange }: { firmId: string; webhookUrl: string; onChange: (v: string) => void }) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; status: number; body: string } | null>(null);

  async function handleTest() {
    setTesting(true);
    setResult(null);
    try {
      const r = await testWebhook(firmId);
      setResult(r);
    } catch {
      setResult({ ok: false, status: 0, body: "Request failed" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="grid gap-2">
      <Label htmlFor="webhook_url">Delivery Webhook (Zapier / Make)</Label>
      <div className="flex gap-2">
        <Input
          id="webhook_url"
          type="url"
          value={webhookUrl}
          onChange={(e) => onChange(e.target.value)}
          placeholder="https://hooks.zapier.com/hooks/catch/..."
        />
        <button
          type="button"
          onClick={handleTest}
          disabled={testing || !webhookUrl}
          className="flex shrink-0 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700 disabled:opacity-40"
        >
          <Zap className="h-3.5 w-3.5" />
          {testing ? "Sending…" : "Test"}
        </button>
      </div>
      {result && (
        <p className={`text-xs ${result.ok ? "text-emerald-600" : "text-rose-600"}`}>
          {result.ok ? `✓ ${result.status} OK` : `✗ ${result.status || "Error"} — ${result.body.slice(0, 120)}`}
        </p>
      )}
      <p className="text-xs text-slate-400">Optional: POST lead data here after each completed intake.</p>
    </div>
  );
}

export function SettingsForm({ initialSettings }: { initialSettings: FirmSettings }) {
  const [form, setForm] = useState(initialSettings);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

  const practiceAreasText = useMemo(() => form.practice_areas.join(", "), [form.practice_areas]);

  function field<K extends keyof FirmSettings>(key: K) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");

    const normalized: FirmSettings = {
      ...form,
      practice_areas: practiceAreasText
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    };

    const saved = await saveSettings(normalized);
    setForm({ ...normalized, ...saved });
    setStatus("saved");
    setTimeout(() => setStatus("idle"), 2000);
  }

  return (
    <form className="space-y-6" onSubmit={onSubmit}>
      {/* ── Assistant ── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle>Assistant</CardTitle>
          <VoicePreviewButton firmId={form.id} />
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="ava_name">Assistant Name</Label>
            <Input
              id="ava_name"
              value={form.ava_name ?? ""}
              onChange={field("ava_name")}
              placeholder="Ava"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tone">Tone</Label>
            <SelectNative id="tone" value={form.tone ?? ""} onChange={field("tone")}>
              {TONES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </SelectNative>
          </div>
        </CardContent>
      </Card>

      {/* ── Firm Profile ── */}
      <Card>
        <CardHeader>
          <CardTitle>Firm Profile</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="name">Firm Name</Label>
            <Input id="name" value={form.name} onChange={field("name")} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="practice_areas">Practice Areas (comma-separated)</Label>
            <Input
              id="practice_areas"
              value={practiceAreasText}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  practice_areas: e.target.value.split(",").map((v) => v.trim()).filter(Boolean),
                }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="office_hours">Office Hours</Label>
            <Input id="office_hours" value={form.office_hours} onChange={field("office_hours")} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="intake_rules">Intake Rules</Label>
            <Textarea id="intake_rules" value={form.intake_rules} onChange={field("intake_rules")} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="disclaimer">Disclaimer</Label>
            <Textarea id="disclaimer" value={form.disclaimer} onChange={field("disclaimer")} />
          </div>
        </CardContent>
      </Card>

      {/* ── Notifications ── */}
      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="notification_email">Notification Email</Label>
            <Input
              id="notification_email"
              type="email"
              value={form.notification_email ?? ""}
              onChange={field("notification_email")}
              placeholder="you@yourfirm.com"
            />
          </div>
        </CardContent>
      </Card>

      {/* ── Phone & Webhook ── */}
      <Card>
        <CardHeader>
          <CardTitle>Phone &amp; Webhook</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="twilio_phone">Twilio Phone Number</Label>
            <Input
              id="twilio_phone"
              type="tel"
              value={form.twilio_phone ?? ""}
              onChange={field("twilio_phone")}
              placeholder="+15551234567"
            />
          </div>
          <div className="grid gap-2">
            <Label>Webhook URL</Label>
            <WebhookCopyField firmId={form.id} />
            <p className="text-xs text-slate-400">
              Set this as the "A Call Comes In" webhook (HTTP POST) on your Twilio number.
            </p>
          </div>
          <WebhookDeliveryField firmId={form.id} webhookUrl={form.webhook_url ?? ""} onChange={(v) => setForm((f) => ({ ...f, webhook_url: v }))} />
        </CardContent>
      </Card>

      {/* ── Save ── */}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={status === "saving"}>
          <Save className="h-4 w-4" />
          {status === "saving" ? "Saving…" : "Save Settings"}
        </Button>
        {status === "saved" && <p className="text-sm text-emerald-700">Saved.</p>}
      </div>
    </form>
  );
}
