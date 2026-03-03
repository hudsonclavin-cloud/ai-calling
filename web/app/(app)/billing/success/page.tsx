"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Check, CheckCircle2, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { sendSetupInstructions } from "@/lib/api";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:5050";

function BillingSuccessInner() {
  const searchParams = useSearchParams();
  const firmId = searchParams.get("firmId") ?? "";
  const isSignup = searchParams.get("signup") === "1";

  const [businessName, setBusinessName] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [instructionsSent, setInstructionsSent] = useState(false);
  const [sendingInstructions, setSendingInstructions] = useState(false);

  const webhookUrl = `${API_BASE}/twiml?firmId=${firmId}`;

  useEffect(() => {
    if (!firmId) return;
    fetch(`${API_BASE}/api/firms/${firmId}`)
      .then((r) => r.json())
      .then((json) => {
        const name = json?.data?.name ?? json?.name ?? "";
        if (name) setBusinessName(name);
      })
      .catch(() => {});
  }, [firmId]);

  async function copyWebhookUrl() {
    await navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSendInstructions() {
    setSendingInstructions(true);
    try {
      await sendSetupInstructions(firmId);
      setInstructionsSent(true);
    } catch {
      // silently fail — user can retry
    } finally {
      setSendingInstructions(false);
    }
  }

  if (isSignup) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="w-full max-w-lg space-y-6">
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
              <Check className="h-7 w-7 text-emerald-600" />
            </span>
            <h1 className="text-2xl font-semibold text-slate-900">
              You&apos;re all set{businessName ? `, ${businessName}` : ""}!
            </h1>
            <p className="text-sm text-slate-500">
              Your Ava assistant is ready. Paste the webhook URL below into Twilio to go live.
            </p>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Your Twilio Webhook URL</CardTitle>
              <CardDescription>
                Configure this URL in Twilio so Ava can answer your calls.
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
                  {copied ? (
                    <Check className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Twilio Setup Steps</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-2 text-sm text-slate-700">
                <li className="flex gap-2">
                  <span className="shrink-0 font-semibold text-slate-400">1.</span>
                  Go to <strong>console.twilio.com</strong> → Phone Numbers
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 font-semibold text-slate-400">2.</span>
                  Click your phone number
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 font-semibold text-slate-400">3.</span>
                  Under <strong>Voice &amp; Fax</strong> → &ldquo;A Call Comes In&rdquo;, set to <strong>Webhook (HTTP POST)</strong>
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 font-semibold text-slate-400">4.</span>
                  Paste your webhook URL above
                </li>
                <li className="flex gap-2">
                  <span className="shrink-0 font-semibold text-slate-400">5.</span>
                  Click <strong>Save</strong>
                </li>
              </ol>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleSendInstructions}
              disabled={sendingInstructions || instructionsSent}
            >
              {instructionsSent ? (
                <>
                  <Check className="h-4 w-4" />
                  Instructions sent!
                </>
              ) : sendingInstructions ? (
                "Sending…"
              ) : (
                "Email me these instructions"
              )}
            </Button>
            <Button asChild className="flex-1">
              <Link href={`/dashboard?firmId=${firmId}`}>Go to my dashboard</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Existing billing activated screen
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center">
      <CheckCircle2 className="h-14 w-14 text-emerald-500" />
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">Billing activated</h1>
        <p className="text-slate-500">
          Your subscription is now active. Ava is ready to take calls for your firm.
        </p>
      </div>
      <Button asChild>
        <Link href="/clients">Back to Clients</Link>
      </Button>
    </div>
  );
}

export default function BillingSuccessPage() {
  return (
    <Suspense>
      <BillingSuccessInner />
    </Suspense>
  );
}
