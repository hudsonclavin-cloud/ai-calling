import { notFound } from "next/navigation";

import { FirmEditForm } from "@/components/firm-edit-form";
import { API_BASE, getFirms } from "@/lib/api";

export default async function FirmEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const firms = await getFirms();
  const firm = firms.find((f) => f.id === id);

  if (!firm) notFound();

  const webhookUrl = `${API_BASE}/twiml?firmId=${firm.id}`;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900 md:text-3xl">{firm.name}</h1>
        <p className="mt-1 text-sm text-slate-500">Edit client configuration</p>
      </div>
      <FirmEditForm initialFirm={firm} webhookUrl={webhookUrl} />
    </div>
  );
}
