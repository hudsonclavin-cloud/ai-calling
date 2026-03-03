import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Ava — AI Legal Intake",
  description: "Operational command center for legal intake calls and lead workflows.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
