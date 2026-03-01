import Link from "next/link";
import { BarChart3, PhoneCall, Settings } from "lucide-react";

import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
  { href: "/calls", label: "Calls", icon: PhoneCall },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({
  children,
  pathname,
  firmName,
}: {
  children: React.ReactNode;
  pathname: string;
  firmName: string;
}) {
  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* ── Sidebar ── */}
      <aside className="hidden w-56 shrink-0 flex-col bg-slate-900 md:flex">
        {/* Logo */}
        <div className="flex items-center gap-2 border-b border-slate-800 px-5 py-5">
          <span className="text-xl font-bold tracking-[0.25em] text-white">AVA</span>
          <span className="mt-0.5 h-2 w-2 rounded-full bg-violet-500" />
        </div>

        {/* Firm name */}
        <div className="border-b border-slate-800 px-5 py-3">
          <p className="truncate text-xs font-medium text-slate-400">{firmName}</p>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-0.5 px-3 py-4">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-lg border-l-2 px-3 py-2.5 text-sm font-medium transition-all",
                  active
                    ? "border-violet-500 bg-slate-800 text-white"
                    : "border-transparent text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        <div className="border-t border-slate-800 px-5 py-4">
          <p className="text-xs text-slate-600">Ava Intake v2</p>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>
      </main>
    </div>
  );
}
