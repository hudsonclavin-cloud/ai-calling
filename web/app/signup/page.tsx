"use client";

import { useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SelectNative } from "@/components/ui/select-native";
import { createFirm, createCheckoutSession } from "@/lib/api";

// ── Constants ─────────────────────────────────────────────────────────────────

const INDUSTRIES = ["Legal", "Medical", "Real Estate", "Home Services", "Financial", "Other"] as const;

const TONES = [
  { value: "warm-professional", label: "Warm & Professional" },
  { value: "friendly",          label: "Friendly & Casual" },
  { value: "formal",            label: "Formal & Corporate" },
] as const;

const INTAKE_RULES: Record<string, string> = {
  Legal:           "Collect caller contact details and a short case summary. Escalate emergency threats to 911 guidance.",
  Medical:         "Collect patient name, callback number, reason for visit, and any urgent symptoms. Do not provide medical advice.",
  "Real Estate":   "Collect buyer or seller status, property interest, timeline, and financing readiness.",
  "Home Services": "Collect service type needed, address, preferred timing, and urgency level.",
  Financial:       "Collect name, callback number, and a brief description of the financial need.",
  Other:           "Collect name, callback number, and a summary of the inquiry.",
};

const STEP_LABELS = ["Business Info", "Assistant", "Phone Setup", "Payment"] as const;

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

// ── Form state ────────────────────────────────────────────────────────────────

interface SignupForm {
  businessName: string;
  industry: string;
  contactName: string;
  notificationEmail: string;
  assistantName: string;
  tone: string;
  serviceAreas: string[];
  hasPhone: boolean;
  twilioPhone: string;
}

const INITIAL_FORM: SignupForm = {
  businessName: "",
  industry: "Legal",
  contactName: "",
  notificationEmail: "",
  assistantName: "Ava",
  tone: "warm-professional",
  serviceAreas: [],
  hasPhone: true,
  twilioPhone: "",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SignupPage() {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<SignupForm>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof SignupForm>(key: K, value: SignupForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function goNext() {
    setStep((s) => Math.min(s + 1, 4));
  }

  function goBack() {
    setStep((s) => Math.max(s - 1, 1));
    setError(null);
  }

  async function handleStartTrial() {
    setSubmitting(true);
    setError(null);
    const firmId = toFirmId(form.businessName);
    try {
      const config = {
        id: firmId,
        name: form.businessName,
        ava_name: form.assistantName,
        tone: form.tone,
        opening: smartOpening(form.businessName, form.assistantName),
        closing: smartClosing(form.businessName),
        practice_areas: form.serviceAreas,
        max_questions: 8,
        intake_rules: INTAKE_RULES[form.industry] ?? INTAKE_RULES.Other,
        notification_email: form.notificationEmail,
        twilio_phone: form.twilioPhone || "",
        contact_name: form.contactName,
      };
      await createFirm(firmId, config);
      const url = await createCheckoutSession(firmId, true);
      window.location.href = url;
    } catch {
      setError("Something went wrong — please check your connection and try again.");
      setSubmitting(false);
    }
  }

  const firmId = toFirmId(form.businessName);

  // ── Shared nav buttons ────────────────────────────────────────────────────

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
            onClick={handleStartTrial}
            disabled={submitting}
          >
            {submitting ? "Redirecting…" : "Start Free Trial"}
          </Button>
        )}
      </div>
    );
  }

  // ── Step 1 — Business Info ─────────────────────────────────────────────────

  if (step === 1) {
    return (
      <div className="flex min-h-screen items-start justify-center bg-slate-50 px-4 py-12">
        <div className="w-full max-w-lg space-y-6">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold tracking-[0.25em] text-slate-900">AVA</span>
            <span className="mb-0.5 h-2 w-2 rounded-full bg-violet-500" />
          </div>

          <div>
            <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Get started with Ava</h1>
            <p className="text-sm text-slate-500">Set up your AI intake assistant in under 5 minutes.</p>
          </div>

          <StepProgress step={step} />

          <Card>
            <CardHeader>
              <CardTitle>Business Information</CardTitle>
              <CardDescription>Tell us about your business.</CardDescription>
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
                    Your ID: <code className="font-mono">{firmId}</code>
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

              <div className="grid gap-2">
                <Label htmlFor="contactName">Your Name</Label>
                <Input
                  id="contactName"
                  placeholder="Jane Smith"
                  value={form.contactName}
                  onChange={(e) => set("contactName", e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="notificationEmail">Notification Email *</Label>
                <Input
                  id="notificationEmail"
                  type="email"
                  placeholder="jane@example.com"
                  value={form.notificationEmail}
                  onChange={(e) => set("notificationEmail", e.target.value)}
                />
                <p className="text-xs text-slate-400">Where we&apos;ll send call summaries and setup instructions.</p>
              </div>
            </CardContent>
          </Card>

          <NavButtons canAdvance={!!form.businessName.trim() && !!form.notificationEmail.trim()} />
        </div>
      </div>
    );
  }

  // ── Step 2 — Assistant Setup ───────────────────────────────────────────────

  if (step === 2) {
    return (
      <div className="flex min-h-screen items-start justify-center bg-slate-50 px-4 py-12">
        <div className="w-full max-w-lg space-y-6">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold tracking-[0.25em] text-slate-900">AVA</span>
            <span className="mb-0.5 h-2 w-2 rounded-full bg-violet-500" />
          </div>

          <div>
            <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Get started with Ava</h1>
            <p className="text-sm text-slate-500">{form.businessName}</p>
          </div>

          <StepProgress step={step} />

          <Card>
            <CardHeader>
              <CardTitle>Assistant Setup</CardTitle>
              <CardDescription>Customize your AI intake assistant.</CardDescription>
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
                <p className="text-xs text-slate-400">Press Enter or comma to add each area.</p>
              </div>
            </CardContent>
          </Card>

          <NavButtons canAdvance={!!form.assistantName.trim() && form.serviceAreas.length > 0} />
        </div>
      </div>
    );
  }

  // ── Step 3 — Phone Setup ───────────────────────────────────────────────────

  if (step === 3) {
    return (
      <div className="flex min-h-screen items-start justify-center bg-slate-50 px-4 py-12">
        <div className="w-full max-w-lg space-y-6">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-bold tracking-[0.25em] text-slate-900">AVA</span>
            <span className="mb-0.5 h-2 w-2 rounded-full bg-violet-500" />
          </div>

          <div>
            <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Get started with Ava</h1>
            <p className="text-sm text-slate-500">{form.businessName}</p>
          </div>

          <StepProgress step={step} />

          <Card>
            <CardHeader>
              <CardTitle>Phone Setup</CardTitle>
              <CardDescription>
                Ava answers calls on a Twilio phone number. Do you already have one?
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-3">
                <div
                  onClick={() => set("hasPhone", true)}
                  className={`cursor-pointer rounded-lg border-2 p-4 transition-colors ${
                    form.hasPhone
                      ? "border-sky-500 bg-sky-50"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${form.hasPhone ? "border-sky-500 bg-sky-500" : "border-slate-300"}`}>
                      {form.hasPhone && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-900">I have a Twilio number</p>
                      <p className="text-xs text-slate-500">Enter your number below and we&apos;ll give you the webhook URL to configure it.</p>
                    </div>
                  </div>
                  {form.hasPhone && (
                    <div className="mt-3">
                      <Input
                        type="tel"
                        placeholder="+14155550100"
                        value={form.twilioPhone}
                        onChange={(e) => set("twilioPhone", e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  )}
                </div>

                <div
                  onClick={() => set("hasPhone", false)}
                  className={`cursor-pointer rounded-lg border-2 p-4 transition-colors ${
                    !form.hasPhone
                      ? "border-sky-500 bg-sky-50"
                      : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${!form.hasPhone ? "border-sky-500 bg-sky-500" : "border-slate-300"}`}>
                      {!form.hasPhone && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-900">I need help getting a number</p>
                      <p className="text-xs text-slate-500">Sign up for a free Twilio trial and get a phone number in minutes.</p>
                    </div>
                  </div>
                  {!form.hasPhone && (
                    <div className="mt-3 rounded-md bg-slate-100 p-3 text-xs text-slate-600 space-y-1">
                      <p>
                        1.{" "}
                        <a
                          href="https://www.twilio.com/try-twilio"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sky-600 underline hover:text-sky-800"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Sign up for Twilio
                        </a>{" "}
                        (free trial available)
                      </p>
                      <p>2. Go to Phone Numbers → Manage → Buy a number</p>
                      <p>3. Come back here and enter your new number on the next step</p>
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          <NavButtons canAdvance={true} />
        </div>
      </div>
    );
  }

  // ── Step 4 — Payment ───────────────────────────────────────────────────────

  const toneLabel = TONES.find((t) => t.value === form.tone)?.label ?? form.tone;

  return (
    <div className="flex min-h-screen items-start justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-lg space-y-6">
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold tracking-[0.25em] text-slate-900">AVA</span>
          <span className="mb-0.5 h-2 w-2 rounded-full bg-violet-500" />
        </div>

        <div>
          <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Get started with Ava</h1>
          <p className="text-sm text-slate-500">Review your setup and start your free trial.</p>
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
              <ReviewRow label="Contact Name" value={form.contactName} />
              <ReviewRow label="Notification Email" value={form.notificationEmail} />
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
              <CardTitle className="text-base">Phone</CardTitle>
            </CardHeader>
            <CardContent>
              <ReviewRow
                label="Twilio Number"
                value={form.hasPhone ? (form.twilioPhone || "Not entered") : "Will configure later"}
              />
            </CardContent>
          </Card>

          <Card className="border-sky-200 bg-sky-50">
            <CardHeader>
              <CardTitle className="text-base text-sky-900">$149 / month</CardTitle>
              <CardDescription className="text-sky-700">Everything you need to automate intake calls.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 text-sm text-sky-800">
                {[
                  "AI-powered phone intake 24/7",
                  "Automatic lead capture & summaries",
                  "Email notifications per call",
                  "Custom assistant name & tone",
                  "Unlimited calls",
                  "Twilio webhook setup support",
                ].map((item) => (
                  <li key={item} className="flex items-center gap-2">
                    <Check className="h-4 w-4 shrink-0 text-sky-600" />
                    {item}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>

        {error && (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {error}
          </p>
        )}

        <NavButtons canAdvance={true} />

        <p className="text-center text-xs text-slate-400">
          Already have an account?{" "}
          <Link href="/login" className="text-sky-600 underline underline-offset-2 hover:text-sky-800">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
