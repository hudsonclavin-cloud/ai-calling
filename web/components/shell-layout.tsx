"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getSettings } from "@/lib/api";

export function ShellLayout({
  children,
  firmName: initialFirmName,
  isAdmin,
}: {
  children: React.ReactNode;
  firmName: string;
  isAdmin: boolean;
}) {
  const pathname = usePathname();
  const [firmName, setFirmName] = useState(initialFirmName);

  useEffect(() => {
    const firmId = new URLSearchParams(window.location.search).get('firmId');
    if (!firmId) return;
    getSettings(firmId).then((s) => {
      if (s?.name) setFirmName(s.name);
    });
  }, []);

  return (
    <AppShell pathname={pathname} firmName={firmName} isAdmin={isAdmin}>
      {children}
    </AppShell>
  );
}
