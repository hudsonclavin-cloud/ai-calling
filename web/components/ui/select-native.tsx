import * as React from "react";

import { cn } from "@/lib/utils";

function SelectNative({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 shadow-xs outline-none transition-colors focus:border-sky-500 focus:ring-2 focus:ring-sky-200",
        className
      )}
      {...props}
    />
  );
}

export { SelectNative };
