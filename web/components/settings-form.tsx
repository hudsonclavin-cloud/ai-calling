"use client";

import { useMemo, useState } from "react";
import { Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { saveSettings } from "@/lib/api";
import type { FirmSettings } from "@/lib/types";

export function SettingsForm({ initialSettings }: { initialSettings: FirmSettings }) {
  const [form, setForm] = useState(initialSettings);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

  const practiceAreasText = useMemo(() => form.practiceAreas.join(", "), [form.practiceAreas]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");

    const normalized: FirmSettings = {
      ...form,
      practiceAreas: practiceAreasText
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    };

    const saved = await saveSettings(normalized);
    setForm(saved);
    setStatus("saved");

    setTimeout(() => setStatus("idle"), 2000);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Firm Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="grid gap-5" onSubmit={onSubmit}>
          <div className="grid gap-2">
            <Label htmlFor="firmName">Firm Name</Label>
            <Input id="firmName" value={form.firmName} onChange={(event) => setForm((prev) => ({ ...prev, firmName: event.target.value }))} />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="practiceAreas">Practice Areas (comma separated)</Label>
            <Input
              id="practiceAreas"
              value={practiceAreasText}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  practiceAreas: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                }))
              }
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="officeHours">Office Hours</Label>
            <Input id="officeHours" value={form.officeHours} onChange={(event) => setForm((prev) => ({ ...prev, officeHours: event.target.value }))} />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="intakeRules">Intake Rules</Label>
            <Textarea
              id="intakeRules"
              value={form.intakeRules}
              onChange={(event) => setForm((prev) => ({ ...prev, intakeRules: event.target.value }))}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="disclaimers">Disclaimers</Label>
            <Textarea
              id="disclaimers"
              value={form.disclaimers}
              onChange={(event) => setForm((prev) => ({ ...prev, disclaimers: event.target.value }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="escalationPhone">Escalation Phone</Label>
              <Input
                id="escalationPhone"
                value={form.escalationPhone}
                onChange={(event) => setForm((prev) => ({ ...prev, escalationPhone: event.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="escalationEmail">Escalation Email</Label>
              <Input
                id="escalationEmail"
                type="email"
                value={form.escalationEmail}
                onChange={(event) => setForm((prev) => ({ ...prev, escalationEmail: event.target.value }))}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={status === "saving"}>
              <Save className="h-4 w-4" />
              {status === "saving" ? "Saving..." : "Save Settings"}
            </Button>
            {status === "saved" ? <p className="text-sm text-emerald-700">Saved.</p> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
