"use client";

import { useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, Copy, X } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { Textarea } from "@/components/ui/textarea";
import { createFirm } from "@/lib/api";

// ── Constants ─────────────────────────────────────────────────────────────────

const INDUSTRIES = ["Legal", "Medical", "Real Estate", "Home Services", "Financial", "Other"] as const;

const TONES = [
  { value: "warm-professional", label: "Warm & Professional" },
  { value: "friendly",          label: "Friendly & Casual" },
  { value: "formal",            label: "Formal & Corporate" },
] as const;

const INTAKE_RULES: Record<string, string> = {
  Legal:          "Collect caller contact details and a short case summary. Escalate emergency threats to 911 guidance.",
  Medical:        "Collect patient name, callback number, reason for visit, and any urgent symptoms. Do not provide medical advice.",
  "Real Estate":  "Collect buyer or seller status, property interest, timeline, and financing readiness.",
  "Home Services":"Collect service type needed, address, preferred timing, and urgency level.",
  Financial:      "Collect name, callback number, and a brief description of the financial need.",
  Other:          "Collect name, callback number, and a summary of the inquiry.",
};

const STEP_LABELS = ["Business Info", "Assistant", "Scripts", "Review"] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function toFirmId(name: string): string {
  return (
    "firm_" +
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
  );
}

function smartOpening(businessName: string, assistantName: string): string {
  const biz = businessName || "our office";
  const ava = assistantName || "Ava";
  return `Hi, this is ${ava} with ${biz}. I'm going to ask you a few quick questions so our team can review your inquiry before calling you back.`;
}

function smartClosing(businessName: string): string {
  const biz = businessName || "our team";
  return `Perfect. I've got everything I need. Someone from ${biz} will review this and reach out to you soon.`;
}

// ── Tag input ─────────────────────────────────────────────────────────────────

function TagInput({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");

  function commitDraft(raw: string) {
    const tag = raw.trim();
    if (tag && !tags.includes(tag)) onChange([...tags, tag]);
    setDraft("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitDraft(draft);
    } else if (e.key === "Backspace" && !draft && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <div className="flex min-h-10 flex-wrap gap-2 rounded-md border border-slate-300 bg-white p-2 transition-colors focus-within:border-sky-500 focus-within:ring-2 focus-within:ring-sky-200">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-3 py-0.5 text-sm font-medium text-sky-800"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            className="ml-0.5 text-sky-400 hover:text-sky-700"
            aria-label={`Remove ${tag}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commitDraft(draft)}
        placeholder={tags.length === 0 ? "Type and press Enter to add…" : "Add another…"}
        className="min-w-[140px] flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
      />
    </div>
  );
}

// ── Form state ────────────────────────────────────────────────────────────────

interface OnboardingForm {
  businessName: string;
  industry: string;
  contactName: string;
  contactEmail: string;
  twilioPhone: string;
  assistantName: string;
  tone: string;
  serviceAreas: string[];
  opening: string;
  closing: string;
  maxQuestions: number;
}

const INITIAL_FORM: OnboardingForm = {
  businessName: "",
  industry: "Legal",
  contactName: "",
  contactEmail: "",
  twilioPhone: "",
  assistantName: "Ava",
  tone: "warm-professional",
  serviceAreas: [],
  opening: "",
  closing: "",
  maxQuestions: 8,
};

// ── Review row ────────────────────────────────────────────────────────────────

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2.5 last:border-0">
      <span className="text-xs font-medium text-slate-400">{label}</span>
      {value ? (
        <span className="text-sm text-slate-900">{value}</span>
      ) : (
        <span className="text-sm italic text-slate-400">—</span>
      )}
    </div>
  );
}

// ── Step progress ─────────────────────────────────────────────────────────────

function StepProgress({ step }: { step: number }) {
  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        {STEP_LABELS.map((_, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i + 1 <= step ? "bg-sky-600" : "bg-slate-200"
            }`}
          />
        ))}
      </div>
      <p className="text-xs text-slate-500">
        Step {step} of 4 — {STEP_LABELS[step - 1]}
      </p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<OnboardingForm>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdFirmId, setCreatedFirmId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const firmId = toFirmId(form.businessName);
  const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:5050";
  const webhookUrl = `${apiBase}/twiml?firmId=${firmId}`;

  function set<K extends keyof OnboardingForm>(key: K, value: OnboardingForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function goNext() {
    // Seed smart default scripts on first entry to step 3
    if (step === 2) {
      setForm((prev) => ({
        ...prev,
        opening: prev.opening || smartOpening(prev.businessName, prev.assistantName),
        closing: prev.closing || smartClosing(prev.businessName),
      }));
    }
    setStep((s) => Math.min(s + 1, 4));
  }

  function goBack() {
    setStep((s) => Math.max(s - 1, 1));
    setError(null);
  }

  async function handleCreate() {
    setSubmitting(true);
    setError(null);
    try {
      await createFirm(firmId, {
        id: firmId,
        name: form.businessName,
        ava_name: form.assistantName,
        tone: form.tone,
        opening: form.opening,
        closing: form.closing,
        practice_areas: form.serviceAreas,
        max_questions: form.maxQuestions,
        intake_rules: INTAKE_RULES[form.industry] ?? INTAKE_RULES.Other,
      });
      setCreatedFirmId(firmId);
    } catch {
      setError("Failed to create client — make sure the backend is running and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyWebhookUrl() {
    await navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── Success ────────────────────────────────────────────────────────────────

  if (createdFirmId) {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div className="flex flex-col items-center gap-3 py-4 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
            <Check className="h-7 w-7 text-emerald-600" />
          </span>
          <h1 className="text-2xl font-semibold text-slate-900">Client created!</h1>
          <p className="text-sm text-slate-500">
            <strong>{form.businessName}</strong> is ready. Paste the webhook URL below into Twilio to go live.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Twilio Webhook URL</CardTitle>
            <CardDescription>
              In Twilio, open the phone number and set the Voice webhook (HTTP POST) to this URL.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
              <code className="flex-1 truncate text-xs text-slate-700">{webhookUrl}</code>
              <button
                onClick={copyWebhookUrl}
                className="shrink-0 rounded p-1 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700"
                aria-label="Copy webhook URL"
              >
                {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-slate-400">
              Firm ID: <code className="font-mono">{createdFirmId}</code>
            </p>
          </CardContent>
        </Card>

        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => {
              setForm(INITIAL_FORM);
              setCreatedFirmId(null);
              setStep(1);
            }}
          >
            Add Another Client
          </Button>
          <Link href="/dashboard" className={buttonVariants({ className: "flex-1" })}>
            Go to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  // ── Shared nav buttons ─────────────────────────────────────────────────────

  function NavButtons({ canAdvance }: { canAdvance: boolean }) {
    return (
      <div className="flex items-center justify-between pt-2">
        {step > 1 ? (
          <Button type="button" variant="outline" size="sm" onClick={goBack}>
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        ) : (
          <div />
        )}
        {step < 4 ? (
          <Button type="button" size="sm" onClick={goNext} disabled={!canAdvance}>
            Next
            <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={handleCreate}
            disabled={submitting || !form.businessName}
          >
            {submitting ? "Creating…" : "Create Client"}
          </Button>
        )}
      </div>
    );
  }

  // ── Step 1 — Business Info ─────────────────────────────────────────────────

  if (step === 1) {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Add New Client</h1>
          <p className="text-sm text-slate-500">Set up a new business in under 5 minutes.</p>
        </div>

        <StepProgress step={step} />

        <Card>
          <CardHeader>
            <CardTitle>Business Information</CardTitle>
            <CardDescription>Basic details about the client's business.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="businessName">Business Name *</Label>
              <Input
                id="businessName"
                placeholder="Redwood Legal Group"
                value={form.businessName}
                onChange={(e) => set("businessName", e.target.value)}
                autoFocus
              />
              {form.businessName && (
                <p className="text-xs text-slate-400">
                  Firm ID: <code className="font-mono">{firmId}</code>
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="industry">Industry</Label>
              <SelectNative
                id="industry"
                value={form.industry}
                onChange={(e) => set("industry", e.target.value)}
              >
                {INDUSTRIES.map((ind) => (
                  <option key={ind} value={ind}>{ind}</option>
                ))}
              </SelectNative>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="contactName">Contact Name</Label>
                <Input
                  id="contactName"
                  placeholder="Jane Smith"
                  value={form.contactName}
                  onChange={(e) => set("contactName", e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="contactEmail">Contact Email</Label>
                <Input
                  id="contactEmail"
                  type="email"
                  placeholder="jane@example.com"
                  value={form.contactEmail}
                  onChange={(e) => set("contactEmail", e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="twilioPhone">Twilio Phone Number</Label>
              <Input
                id="twilioPhone"
                type="tel"
                placeholder="+14155550100"
                value={form.twilioPhone}
                onChange={(e) => set("twilioPhone", e.target.value)}
              />
              <p className="text-xs text-slate-400">The number Ava will answer calls on.</p>
            </div>
          </CardContent>
        </Card>

        <NavButtons canAdvance={!!form.businessName.trim()} />
      </div>
    );
  }

  // ── Step 2 — Assistant Setup ───────────────────────────────────────────────

  if (step === 2) {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Add New Client</h1>
          <p className="text-sm text-slate-500">{form.businessName}</p>
        </div>

        <StepProgress step={step} />

        <Card>
          <CardHeader>
            <CardTitle>Assistant Setup</CardTitle>
            <CardDescription>Customize the AI intake assistant for this client.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="assistantName">Assistant Name</Label>
                <Input
                  id="assistantName"
                  placeholder="Ava"
                  value={form.assistantName}
                  onChange={(e) => set("assistantName", e.target.value)}
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
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </SelectNative>
              </div>
            </div>

            <div className="grid gap-2">
              <Label>
                {form.industry === "Legal" ? "Practice Areas" : "Service Areas"} *
              </Label>
              <TagInput
                tags={form.serviceAreas}
                onChange={(tags) => set("serviceAreas", tags)}
              />
              <p className="text-xs text-slate-400">
                Press Enter or comma to add each area.
              </p>
            </div>
          </CardContent>
        </Card>

        <NavButtons canAdvance={!!form.assistantName.trim() && form.serviceAreas.length > 0} />
      </div>
    );
  }

  // ── Step 3 — Scripts ──────────────────────────────────────────────────────

  if (step === 3) {
    return (
      <div className="mx-auto max-w-lg space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Add New Client</h1>
          <p className="text-sm text-slate-500">{form.businessName}</p>
        </div>

        <StepProgress step={step} />

        <Card>
          <CardHeader>
            <CardTitle>Scripts</CardTitle>
            <CardDescription>
              What {form.assistantName} says at the start and end of every call.
            </CardDescription>
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

            <div className="grid gap-2">
              <Label htmlFor="maxQuestions">Max Questions per Call</Label>
              <Input
                id="maxQuestions"
                type="number"
                min={4}
                max={20}
                value={form.maxQuestions}
                onChange={(e) => set("maxQuestions", Math.max(4, Number(e.target.value)))}
                className="w-28"
              />
              <p className="text-xs text-slate-400">
                {form.assistantName} wraps up after this many turns even if intake is incomplete.
              </p>
            </div>
          </CardContent>
        </Card>

        <NavButtons canAdvance={true} />
      </div>
    );
  }

  // ── Step 4 — Review ───────────────────────────────────────────────────────

  const toneLabel = TONES.find((t) => t.value === form.tone)?.label ?? form.tone;

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Add New Client</h1>
        <p className="text-sm text-slate-500">Review everything before creating.</p>
      </div>

      <StepProgress step={step} />

      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Business Info</CardTitle>
          </CardHeader>
          <CardContent>
            <ReviewRow label="Business Name" value={form.businessName} />
            <ReviewRow label="Industry" value={form.industry} />
            <ReviewRow
              label="Contact"
              value={[form.contactName, form.contactEmail].filter(Boolean).join(" · ")}
            />
            <ReviewRow label="Twilio Number" value={form.twilioPhone} />
            <ReviewRow label="Firm ID" value={firmId} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Assistant</CardTitle>
          </CardHeader>
          <CardContent>
            <ReviewRow label="Name" value={form.assistantName} />
            <ReviewRow label="Tone" value={toneLabel} />
            <ReviewRow label="Service Areas" value={form.serviceAreas.join(", ")} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Scripts</CardTitle>
          </CardHeader>
          <CardContent>
            <ReviewRow label="Opening" value={form.opening} />
            <ReviewRow label="Closing" value={form.closing} />
            <ReviewRow label="Max Questions" value={String(form.maxQuestions)} />
          </CardContent>
        </Card>
      </div>

      {error && (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      )}

      <NavButtons canAdvance={true} />
    </div>
  );
}
