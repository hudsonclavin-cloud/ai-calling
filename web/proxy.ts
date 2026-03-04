import { auth } from "@/auth";
import { NextResponse } from "next/server";

// Routes only the GitHub admin can access
const ADMIN_ONLY = ["/clients", "/onboarding"];

// Routes accessible to admin OR a client with a firmId query param
const PROTECTED = ["/dashboard", "/leads", "/calls", "/settings"];

export default auth((req) => {
  const { pathname, searchParams } = req.nextUrl;
  const isAdmin = !!req.auth;

  // Already authenticated admin visiting /login — send to dashboard
  if (pathname === "/login") {
    if (isAdmin) return NextResponse.redirect(new URL("/dashboard", req.url));
    return NextResponse.next();
  }

  // Admin-only routes
  if (ADMIN_ONLY.some((p) => pathname.startsWith(p))) {
    if (!isAdmin) return NextResponse.redirect(new URL("/login", req.url));
    return NextResponse.next();
  }

  // Protected routes — admin or client with firmId
  if (PROTECTED.some((p) => pathname.startsWith(p))) {
    const firmId = searchParams.get("firmId");
    const hasClientAccess = !!firmId;
    if (!isAdmin && !hasClientAccess) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/leads/:path*",
    "/calls/:path*",
    "/settings/:path*",
    "/clients/:path*",
    "/onboarding/:path*",
    "/login",
  ],
};
