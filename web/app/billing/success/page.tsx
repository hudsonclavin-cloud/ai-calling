import Link from "next/link";
import { CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function BillingSuccessPage() {
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
