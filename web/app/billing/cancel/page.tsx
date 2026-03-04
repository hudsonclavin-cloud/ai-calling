import Link from "next/link";
import { XCircle } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

export default function BillingCancelPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center">
      <XCircle className="h-14 w-14 text-slate-400" />
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">Billing setup canceled</h1>
        <p className="text-slate-500">
          No charges were made. You can set up billing any time from the client settings page.
        </p>
      </div>
      <Link href="/clients" className={buttonVariants({ variant: "outline" })}>Back to Clients</Link>
    </div>
  );
}
