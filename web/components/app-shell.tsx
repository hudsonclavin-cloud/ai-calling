import Link from "next/link";
import { BarChart3, PhoneCall, Settings, UserRound } from "lucide-react";

import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
  { href: "/calls", label: "Calls", icon: PhoneCall },
  { href: "/leads/lead-3001", label: "Lead Detail", icon: UserRound },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({ children, pathname }: { children: React.ReactNode; pathname: string }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-100 via-sky-50 to-white text-slate-900">
      <div className="mx-auto grid min-h-screen max-w-7xl grid-cols-1 gap-6 p-4 md:grid-cols-[220px_1fr] md:p-6">
        <aside className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm backdrop-blur">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sky-600">AI Intake</p>
          <p className="mt-1 text-lg font-semibold">Firm Command</p>
          <nav className="mt-6 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    active ? "bg-sky-600 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>
        <main className="rounded-2xl border border-slate-200 bg-white/90 p-4 shadow-sm backdrop-blur md:p-6">{children}</main>
      </div>
    </div>
  );
}
