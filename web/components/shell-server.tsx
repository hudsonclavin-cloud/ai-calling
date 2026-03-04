import { auth } from "@/auth";
import { ShellLayout } from "@/components/shell-layout";
import { getSettings } from "@/lib/api";

export async function ShellServer({ children }: { children: React.ReactNode }) {
  const [settings, session] = await Promise.all([getSettings(), auth().catch(() => null)]);
  return (
    <ShellLayout firmName={settings?.name ?? "Your Firm"} isAdmin={!!session?.user}>
      {children}
    </ShellLayout>
  );
}
