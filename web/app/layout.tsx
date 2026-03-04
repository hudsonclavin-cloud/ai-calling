import type { Metadata } from "next";
import { headers } from "next/headers";

import { auth } from "@/auth";
import { ShellLayout } from "@/components/shell-layout";
import { getSettings } from "@/lib/api";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ava — AI Legal Intake",
  description: "Operational command center for legal intake calls and lead workflows.",
};

const PUBLIC_ROUTES = ["/signup", "/login"];

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const headersList = await headers();
  const pathname = headersList.get("x-pathname") ?? "";
  const isPublic = PUBLIC_ROUTES.some((p) => pathname === p);

  if (isPublic) {
    return (
      <html lang="en">
        <body className="antialiased">{children}</body>
      </html>
    );
  }

  const [settings, session] = await Promise.all([getSettings(), auth().catch(() => null)]);
  const firmName = settings?.name ?? "Your Firm";
  const isAdmin = !!session?.user;

  return (
    <html lang="en">
      <body className="antialiased">
        <ShellLayout firmName={firmName} isAdmin={isAdmin}>{children}</ShellLayout>
      </body>
    </html>
  );
}
