"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BarChart3, Building2, LogOut, Menu, PhoneCall, Settings, Users, X } from "lucide-react";
import { signOut } from "next-auth/react";

import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
  { href: "/clients", label: "Clients", icon: Building2, adminOnly: true },
  { href: "/leads", label: "Leads", icon: Users },
  { href: "/calls", label: "Calls", icon: PhoneCall },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AppShell({
  children,
  pathname,
  firmName,
  isAdmin,
}: {
  children: React.ReactNode;
  pathname: string;
  firmName: string;
  isAdmin: boolean;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const router = useRouter();
  const firmIdRef = useRef('');

  useEffect(() => {
    firmIdRef.current = new URLSearchParams(window.location.search).get('firmId') ?? '';
  }, []);

  function navTo(path: string) {
    const dest = firmIdRef.current ? `${path}?firmId=${firmIdRef.current}` : path;
    router.push(dest);
  }

  const visibleNav = navItems.filter((item) => !item.adminOnly || isAdmin);

  const SidebarContent = () => (
    <>
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
        {visibleNav.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <a
              key={item.href}
              href="#"
              onClick={(e) => { e.preventDefault(); setSidebarOpen(false); navTo(item.href); }}
              className={cn(
                "flex items-center gap-3 rounded-lg border-l-2 px-3 py-2.5 text-sm font-medium transition-all",
                active
                  ? "border-violet-500 bg-slate-800 text-white"
                  : "border-transparent text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {item.label}
            </a>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-slate-800 px-4 py-4 space-y-1">
        {isAdmin && (
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        )}
        {!isAdmin && (
          <Link
            href="/login"
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </Link>
        )}
        <p className="px-3 text-xs text-slate-700">Ava Intake v2</p>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* ── Desktop Sidebar ── */}
      <aside className="hidden w-56 shrink-0 flex-col bg-slate-900 md:flex">
        <SidebarContent />
      </aside>

      {/* ── Mobile Sidebar Overlay ── */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Mobile Sidebar Drawer ── */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-56 shrink-0 flex-col bg-slate-900 transition-transform md:hidden",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <button
          onClick={() => setSidebarOpen(false)}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
        <SidebarContent />
      </aside>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-auto">
        {/* Mobile top bar with hamburger */}
        <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-bold tracking-[0.2em] text-slate-900">AVA</span>
        </div>
        <div className="mx-auto max-w-5xl px-6 py-8">{children}</div>
      </main>
    </div>
  );
}
