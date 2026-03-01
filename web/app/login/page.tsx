"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Github, LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const router = useRouter();
  const [firmId, setFirmId] = useState("");
  const [firmIdError, setFirmIdError] = useState("");

  function handleClientAccess(e: React.FormEvent) {
    e.preventDefault();
    const id = firmId.trim();
    if (!id) {
      setFirmIdError("Please enter a Firm ID.");
      return;
    }
    router.push(`/dashboard?firmId=${encodeURIComponent(id)}`);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo */}
        <div className="flex items-center justify-center gap-2">
          <span className="text-3xl font-bold tracking-[0.25em] text-slate-900">AVA</span>
          <span className="mb-1 h-2.5 w-2.5 rounded-full bg-violet-500" />
        </div>

        {/* Admin sign-in */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Admin access</CardTitle>
            <CardDescription>Sign in with your GitHub account.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className="w-full"
              onClick={() => signIn("github", { callbackUrl: "/dashboard" })}
            >
              <Github className="h-4 w-4" />
              Sign in with GitHub
            </Button>
          </CardContent>
        </Card>

        {/* Divider */}
        <div className="flex items-center gap-3">
          <div className="flex-1 border-t border-slate-200" />
          <span className="text-xs text-slate-400">or</span>
          <div className="flex-1 border-t border-slate-200" />
        </div>

        {/* Client access */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Client access</CardTitle>
            <CardDescription>Enter your Firm ID to view your dashboard.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleClientAccess} className="space-y-3">
              <div className="grid gap-1.5">
                <Label htmlFor="firmId">Firm ID</Label>
                <Input
                  id="firmId"
                  placeholder="firm_default"
                  value={firmId}
                  onChange={(e) => {
                    setFirmId(e.target.value);
                    setFirmIdError("");
                  }}
                  autoComplete="off"
                />
                {firmIdError && (
                  <p className="text-xs text-rose-600">{firmIdError}</p>
                )}
              </div>
              <Button type="submit" variant="outline" className="w-full">
                <LogIn className="h-4 w-4" />
                View Dashboard
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-slate-400">
          Don&apos;t know your Firm ID? Contact your administrator.
        </p>
      </div>
    </div>
  );
}
