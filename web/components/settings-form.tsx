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

  const practiceAreasText = useMemo(() => form.practice_areas.join(", "), [form.practice_areas]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("saving");

    const normalized: FirmSettings = {
      ...form,
      practice_areas: practiceAreasText
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
            <Label htmlFor="name">Firm Name</Label>
            <Input id="name" value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="practice_areas">Practice Areas (comma separated)</Label>
            <Input
              id="practice_areas"
              value={practiceAreasText}
              onChange={(event) =>
                setForm((prev) => ({
                  ...prev,
                  practice_areas: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                }))
              }
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="office_hours">Office Hours</Label>
            <Input id="office_hours" value={form.office_hours} onChange={(event) => setForm((prev) => ({ ...prev, office_hours: event.target.value }))} />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="intake_rules">Intake Rules</Label>
            <Textarea
              id="intake_rules"
              value={form.intake_rules}
              onChange={(event) => setForm((prev) => ({ ...prev, intake_rules: event.target.value }))}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="disclaimer">Disclaimer</Label>
            <Textarea
              id="disclaimer"
              value={form.disclaimer}
              onChange={(event) => setForm((prev) => ({ ...prev, disclaimer: event.target.value }))}
            />
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
