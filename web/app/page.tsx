import Link from "next/link";
import {
  ArrowRight,
  Bell,
  CheckCircle2,
  Clock,
  FileText,
  Mail,
  Mic2,
  Phone,
  PhoneCall,
  Sparkles,
  Layers,
  Zap,
} from "lucide-react";

// ── Shared primitives ──────────────────────────────────────────────────────────

function GradientText({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-gradient-to-r from-amber-400 to-yellow-300 bg-clip-text text-transparent">
      {children}
    </span>
  );
}

function PrimaryButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-full bg-amber-500 px-7 py-3.5 text-sm font-semibold text-white shadow-lg shadow-amber-500/25 transition-all hover:bg-amber-400 hover:shadow-amber-400/30 active:scale-95"
    >
      {children}
    </Link>
  );
}

function DemoButton() {
  return (
    <a
      href="tel:+15554999366"
      className="inline-flex items-center gap-2 rounded-full border border-slate-700 px-7 py-3.5 text-sm font-semibold text-slate-300 transition-all hover:border-slate-500 hover:text-white active:scale-95"
    >
      <Phone className="h-4 w-4" /> Hear Ava in Action
    </a>
  );
}

// ── Section: Hero ─────────────────────────────────────────────────────────────

function Hero({ demoNumber }: { demoNumber?: string | null }) {
  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 pb-24 pt-32 text-center">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-0 h-[600px] w-[900px] -translate-x-1/2 rounded-full bg-amber-600/10 blur-[120px]" />
        <div className="absolute left-1/4 top-1/3 h-[400px] w-[400px] rounded-full bg-yellow-600/8 blur-[100px]" />
      </div>

      {/* Badge */}
      <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs font-medium text-amber-400">
        <Sparkles className="h-3.5 w-3.5" />
        AI-powered phone intake · Available 24/7
      </div>

      {/* Headline */}
      <h1 className="font-serif mx-auto max-w-3xl text-5xl font-bold leading-[1.1] tracking-tight text-white sm:text-6xl lg:text-7xl">
        Your firm&apos;s first impression,{" "}
        <GradientText>handled.</GradientText>
      </h1>

      {/* Subheading */}
      <p className="mx-auto mt-7 max-w-xl text-lg leading-relaxed text-slate-400">
        Ava answers every call, qualifies leads, and notifies your team instantly
        — so no opportunity ever goes to voicemail.
      </p>

      {/* CTAs */}
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <PrimaryButton href="/signup">
          Start Free Trial
          <ArrowRight className="h-4 w-4" />
        </PrimaryButton>
        <DemoButton />
      </div>
      {demoNumber && (
        <p className="mt-3 text-sm text-slate-400">
          Or call{" "}
          <a href={`tel:${demoNumber}`} className="font-mono text-amber-400 hover:text-amber-300">
            {demoNumber}
          </a>{" "}
          to hear Ava in action
        </p>
      )}

      {/* Hero visual */}
      <div className="mt-20 w-full max-w-2xl">
        <div className="relative rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-2xl backdrop-blur-sm">
          {/* Fake call UI */}
          <div className="mb-4 flex items-center gap-3 border-b border-slate-800 pb-4">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/20">
              <PhoneCall className="h-4 w-4 text-emerald-400" />
            </div>
            <div className="text-left">
              <p className="text-sm font-medium text-white">Incoming call</p>
              <p className="text-xs text-slate-500">+1 (415) 555-0142 · 2 min ago</p>
            </div>
            <div className="ml-auto flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
              Live
            </div>
          </div>
          <div className="space-y-3 text-left">
            {[
              { role: "ava", text: "Hi, this is Ava with Redwood Legal Group. I'll ask a few quick questions so the attorney can review your case. What's your name?" },
              { role: "caller", text: "Sarah Chen." },
              { role: "ava", text: "Thanks, Sarah. What type of legal matter are you calling about?" },
              { role: "caller", text: "A personal injury case — I was in a car accident last week." },
            ].map((msg, i) => (
              <div key={i} className={`flex gap-3 ${msg.role === "ava" ? "" : "flex-row-reverse"}`}>
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${msg.role === "ava" ? "bg-amber-500/20 text-amber-400" : "bg-slate-700 text-slate-400"}`}>
                  {msg.role === "ava" ? "A" : "C"}
                </div>
                <div className={`max-w-xs rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${msg.role === "ava" ? "bg-slate-800 text-slate-200" : "bg-amber-500/20 text-amber-200"}`}>
                  {msg.text}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3">
            <Bell className="h-4 w-4 text-emerald-400" />
            <p className="text-xs text-emerald-300">
              Lead summary emailed to <span className="font-medium">team@redwoodlegal.com</span>
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ── Section: Social proof ──────────────────────────────────────────────────────

function SocialProof() {
  const industries = [
    "Law Firms",
    "Medical Practices",
    "Real Estate Agencies",
    "Home Services",
    "Financial Advisors",
    "Dental Offices",
  ];

  return (
    <section className="border-y border-slate-800/60 bg-slate-900/40 py-10">
      <div className="mx-auto max-w-5xl px-6 text-center">
        <p className="mb-6 text-xs font-semibold uppercase tracking-widest text-slate-500">
          Built for law firms, medical practices, and service businesses
        </p>
        <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
          {industries.map((name) => (
            <span key={name} className="text-sm font-medium text-slate-500 transition-colors hover:text-slate-300">
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Section: How it works ──────────────────────────────────────────────────────

function HowItWorks() {
  const steps = [
    {
      icon: <Phone className="h-6 w-6" />,
      step: "01",
      title: "Caller calls your number",
      desc: "Ava picks up instantly — no hold music, no voicemail. Every call is answered in under two rings, 24/7.",
    },
    {
      icon: <Sparkles className="h-6 w-6" />,
      step: "02",
      title: "Ava collects what you need",
      desc: "She asks your intake questions naturally, qualifies the lead, and captures name, contact info, and case details.",
    },
    {
      icon: <Zap className="h-6 w-6" />,
      step: "03",
      title: "Your team gets notified instantly",
      desc: "The moment the call ends, a complete lead summary lands in your inbox. Ready to follow up immediately.",
    },
  ];

  return (
    <section id="how" className="py-28 px-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-16 text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-amber-400">How it works</p>
          <h2 className="font-serif text-4xl font-bold tracking-tight text-white">
            From ring to lead summary in{" "}
            <GradientText>under 3 minutes</GradientText>
          </h2>
        </div>

        <div className="grid gap-8 md:grid-cols-3">
          {steps.map((s) => (
            <div key={s.step} className="group relative rounded-2xl border border-slate-800 bg-slate-900/60 p-8 transition-colors hover:border-slate-700">
              <div className="absolute right-6 top-6 text-5xl font-black text-slate-800 transition-colors group-hover:text-slate-700">
                {s.step}
              </div>
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
                {s.icon}
              </div>
              <h3 className="font-serif mb-3 text-lg font-semibold text-white">{s.title}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{s.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Section: Features ─────────────────────────────────────────────────────────

function Features() {
  const features = [
    {
      icon: <Clock className="h-5 w-5" />,
      title: "24/7 availability",
      desc: "Ava never sleeps, never takes vacations, and never sends a caller to voicemail. Every call is answered, every time.",
    },
    {
      icon: <Mail className="h-5 w-5" />,
      title: "Instant lead summaries",
      desc: "The moment a call ends, a clean summary — name, contact info, case details — lands in your inbox. Ready to act on immediately.",
    },
    {
      icon: <Mic2 className="h-5 w-5" />,
      title: "Custom voice & personality",
      desc: "Name your assistant, set the tone, define what it asks. Ava sounds like your team, not a generic bot.",
    },
    {
      icon: <Phone className="h-5 w-5" />,
      title: "Works with any number",
      desc: "Use your existing business number or provision a new dedicated number. No new hardware or phone system required.",
    },
    {
      icon: <FileText className="h-5 w-5" />,
      title: "Call transcripts",
      desc: "Every conversation is transcribed and stored. Review exactly what was said, search by keyword, and export any time.",
    },
    {
      icon: <Layers className="h-5 w-5" />,
      title: "Industry-aware",
      desc: "Ava understands legal, medical, real estate, and home services. She asks the right questions for your specific field.",
    },
  ];

  return (
    <section className="py-28 px-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-16 text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-amber-400">Features</p>
          <h2 className="font-serif text-4xl font-bold tracking-tight text-white">
            Everything you need.{" "}
            <GradientText>Nothing you don&apos;t.</GradientText>
          </h2>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 transition-colors hover:border-slate-700">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400">
                {f.icon}
              </div>
              <h3 className="font-serif mb-2 text-base font-semibold text-white">{f.title}</h3>
              <p className="text-sm leading-relaxed text-slate-400">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── Section: Pricing ──────────────────────────────────────────────────────────

function Pricing() {
  const includes = [
    "Unlimited calls answered",
    "AI-powered lead qualification",
    "Instant email summaries",
    "Custom assistant name & tone",
    "Works with your existing number",
    "Call transcripts & recordings",
    "Dashboard & lead history",
    "Cancel anytime",
  ];

  return (
    <section className="py-28 px-6">
      <div className="mx-auto max-w-lg">
        <div className="mb-12 text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-amber-400">Pricing</p>
          <h2 className="font-serif text-4xl font-bold tracking-tight text-white">
            Simple,{" "}
            <GradientText>honest pricing</GradientText>
          </h2>
          <p className="mt-4 text-slate-400">
            Everything included. No setup fees. Cancel anytime.
          </p>
        </div>

        <div className="relative rounded-2xl border border-amber-500/30 bg-gradient-to-b from-slate-900 to-slate-900/80 p-10 shadow-2xl shadow-amber-500/10">
          {/* Glow */}
          <div className="pointer-events-none absolute inset-0 -z-10 rounded-2xl bg-amber-500/5" />

          <div className="mb-8 text-center">
            <div className="flex items-end justify-center gap-2">
              <span className="text-6xl font-black text-white">$149</span>
              <span className="mb-3 text-slate-400">/ month</span>
            </div>
            <p className="mt-2 text-sm text-slate-500">per business · billed monthly</p>
          </div>

          <ul className="mb-10 space-y-3">
            {includes.map((item) => (
              <li key={item} className="flex items-center gap-3 text-sm text-slate-300">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-amber-400" />
                {item}
              </li>
            ))}
          </ul>

          <PrimaryButton href="/signup">
            Start Free Trial
            <ArrowRight className="h-4 w-4" />
          </PrimaryButton>
        </div>
      </div>
    </section>
  );
}

// ── Section: Footer ───────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="border-t border-slate-800/60 px-6 py-12">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 sm:flex-row">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold tracking-[0.2em] text-white">AVA</span>
          <span className="h-2 w-2 rounded-full bg-amber-500" />
          <span className="text-sm text-slate-500">AI Intake Assistant</span>
        </div>
        <div className="flex items-center gap-6 text-sm text-slate-500">
          <Link href="/signup" className="transition-colors hover:text-slate-300">
            Start Free Trial
          </Link>
          <Link href="/login" className="transition-colors hover:text-slate-300">
            Sign in
          </Link>
          <Link href="/privacy" className="transition-colors hover:text-slate-300">
            Privacy
          </Link>
          <Link href="/terms" className="transition-colors hover:text-slate-300">
            Terms
          </Link>
        </div>
      </div>
    </footer>
  );
}

// ── Nav ───────────────────────────────────────────────────────────────────────

function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-slate-800/50 bg-slate-950/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold tracking-[0.2em] text-white">AVA</span>
          <span className="mb-0.5 h-2 w-2 rounded-full bg-amber-500" />
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/login"
            className="text-sm text-slate-400 transition-colors hover:text-white"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="rounded-full bg-amber-500 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-400"
          >
            Start Free Trial
          </Link>
        </div>
      </div>
    </header>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

async function getDemoNumber(): Promise<string | null> {
  try {
    const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:5050";
    const res = await fetch(`${apiBase}/api/demo-number`, { cache: "no-store" });
    if (!res.ok) return null;
    const { number } = await res.json();
    return number ?? null;
  } catch {
    return null;
  }
}

export default async function LandingPage() {
  const demoNumber = await getDemoNumber();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Nav />
      <Hero demoNumber={demoNumber} />
      <SocialProof />
      <HowItWorks />
      <Features />
      <Pricing />
      <Footer />
    </div>
  );
}
