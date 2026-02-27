"use client";

import { usePathname } from "next/navigation";

import { AppShell } from "@/components/app-shell";

export function ShellLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return <AppShell pathname={pathname}>{children}</AppShell>;
}
