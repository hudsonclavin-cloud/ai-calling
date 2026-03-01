"use client";

import { usePathname } from "next/navigation";

import { AppShell } from "@/components/app-shell";

export function ShellLayout({ children, firmName }: { children: React.ReactNode; firmName: string }) {
  const pathname = usePathname();
  return <AppShell pathname={pathname} firmName={firmName}>{children}</AppShell>;
}
