import { SettingsForm } from "@/components/settings-form";
import { getSettings } from "@/lib/api";

export default async function SettingsPage() {
  const settings = await getSettings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">Settings</h1>
        <p className="text-sm text-slate-500">Manage your firm profile, intake rules, and escalation contacts.</p>
      </div>
      {settings ? (
        <SettingsForm initialSettings={settings} />
      ) : (
        <p className="text-sm text-slate-500">Settings unavailable — backend may be offline.</p>
      )}
    </div>
  );
}
