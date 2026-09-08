import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";

// Server-side proxy to the Fastify API for privileged calls.
//
// Two problems it solves:
//  1. The admin key used to be shipped to browsers as NEXT_PUBLIC_ADMIN_KEY,
//     which Next inlines into the public JS bundle — anyone who loaded the site
//     could read it out of a chunk and then call the admin API directly. The key
//     now lives only in this server-side handler.
//  2. The backend refuses unauthenticated writes to an existing firm's config,
//     because that route is how a firm's lead notifications get redirected. The
//     dashboard authenticates as the admin here and forwards the request.
//
// Everything through this route requires the admin GitHub session. It is not a
// general-purpose proxy: only the prefixes below are forwarded.

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? process.env.API_BASE ?? "http://127.0.0.1:5050";

const ALLOWED_PREFIXES = [
  "api/firms",
  "api/admin",
  "api/dashboard-leads",
  "api/analytics",
  "api/webhook-logs",
  "api/test-webhook",
  "api/billing/portal",
];

function isAllowed(pathParts: string[]) {
  const joined = pathParts.join("/");
  if (joined.includes("..")) return false;
  return ALLOWED_PREFIXES.some((p) => joined === p || joined.startsWith(`${p}/`));
}

async function forward(req: NextRequest, pathParts: string[], method: "GET" | "POST" | "PATCH") {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isAllowed(pathParts)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return NextResponse.json(
      { error: "ADMIN_API_KEY is not configured on the dashboard service" },
      { status: 503 },
    );
  }

  const search = req.nextUrl.search ?? "";
  const url = `${API_BASE.replace(/\/$/, "")}/${pathParts.join("/")}${search}`;
  const body = method === "GET" ? undefined : await req.text();

  const upstream = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-admin-key": adminKey,
    },
    body,
    cache: "no-store",
  });

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") ?? "application/json" },
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return forward(req, path, "GET");
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return forward(req, path, "POST");
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return forward(req, path, "PATCH");
}
