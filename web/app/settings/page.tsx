import { SettingsForm } from "@/components/settings-form";
import { BillingCard } from "@/components/billing-card";
import { getSettings } from "@/lib/api";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ firmId?: string }>;
}) {
  // Without the firmId this page loaded — and SAVED — firm_default for every
  // client, so a firm editing its own settings was rewriting the fallback config
  // that unknown firmIds inherit.
  const { firmId } = await searchParams;
  const settings = await getSettings(firmId);

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
      <BillingCard firmId={settings?.id} />
    </div>
  );
}
