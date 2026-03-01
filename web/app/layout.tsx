import type { Metadata } from "next";

import { ShellLayout } from "@/components/shell-layout";
import { getSettings } from "@/lib/api";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ava — AI Legal Intake",
  description: "Operational command center for legal intake calls and lead workflows.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const settings = await getSettings();
  const firmName = settings?.name ?? "Your Firm";

  return (
    <html lang="en">
      <body className="antialiased">
        <ShellLayout firmName={firmName}>{children}</ShellLayout>
      </body>
    </html>
  );
}
