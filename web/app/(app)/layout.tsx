import { auth } from "@/auth";
import { ShellLayout } from "@/components/shell-layout";
import { getSettings } from "@/lib/api";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [settings, session] = await Promise.all([getSettings(), auth().catch(() => null)]);
  const firmName = settings?.name ?? "Your Firm";
  const isAdmin = !!session?.user;

  return (
    <ShellLayout firmName={firmName} isAdmin={isAdmin}>
      {children}
    </ShellLayout>
  );
}
