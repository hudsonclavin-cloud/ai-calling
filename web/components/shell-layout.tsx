"use client";

import { usePathname } from "next/navigation";

import { AppShell } from "@/components/app-shell";

export function ShellLayout({
  children,
  firmName,
  isAdmin,
}: {
  children: React.ReactNode;
  firmName: string;
  isAdmin: boolean;
}) {
  const pathname = usePathname();

  // Login page renders without any shell
  if (pathname === "/login") return <>{children}</>;

  return (
    <AppShell pathname={pathname} firmName={firmName} isAdmin={isAdmin}>
      {children}
    </AppShell>
  );
}
