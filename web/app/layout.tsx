import type { Metadata } from "next";

import { ShellLayout } from "@/components/shell-layout";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Calling Dashboard",
  description: "Operational command center for legal intake calls and lead workflows.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <ShellLayout>{children}</ShellLayout>
      </body>
    </html>
  );
}
