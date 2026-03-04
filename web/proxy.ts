import { auth } from "@/auth";
import { NextResponse } from "next/server";

// Routes only the GitHub admin can access
const ADMIN_ONLY = ["/clients", "/onboarding"];

// Routes accessible to admin OR a client with a firmId query param
const PROTECTED = ["/dashboard", "/leads", "/calls", "/settings"];

export default auth((req) => {
  const { pathname, searchParams } = req.nextUrl;
  const isAdmin = !!req.auth;

  // Always forward pathname to server components via request header
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", pathname);
  const next = NextResponse.next({ request: { headers: requestHeaders } });

  // Public routes — no auth required
  if (pathname === "/signup") return next;

  // Already authenticated admin visiting /login — send to dashboard
  if (pathname === "/login") {
    if (isAdmin) return NextResponse.redirect(new URL("/dashboard", req.url));
    return next;
  }

  // Admin-only routes
  if (ADMIN_ONLY.some((p) => pathname.startsWith(p))) {
    if (!isAdmin) return NextResponse.redirect(new URL("/login", req.url));
    return next;
  }

  // Protected routes — admin or client with firmId
  if (PROTECTED.some((p) => pathname.startsWith(p))) {
    const firmId = searchParams.get("firmId");
    const hasClientAccess = !!firmId;
    if (!isAdmin && !hasClientAccess) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
  }

  return next;
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)" ],
};
