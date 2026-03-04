import Link from "next/link";
import {
  ArrowRight,
  Bell,
  CheckCircle2,
  Clock,
  Mail,
  Mic2,
  Phone,
  PhoneCall,
  Sparkles,
  Zap,
} from "lucide-react";

// ── Shared primitives ──────────────────────────────────────────────────────────

function GradientText({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-gradient-to-r from-sky-400 to-violet-400 bg-clip-text text-transparent">
      {children}
    </span>
  );
}

function PrimaryButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-full bg-sky-500 px-7 py-3.5 text-sm font-semibold text-white shadow-lg shadow-sky-500/25 transition-all hover:bg-sky-400 hover:shadow-sky-400/30 active:scale-95"
    >
      {children}
    </Link>
  );
}

function GhostButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-full border border-slate-700 px-7 py-3.5 text-sm font-semibold text-slate-300 transition-all hover:border-slate-500 hover:text-white active:scale-95"
    >
      {children}
    </Link>
  );
}

// ── Section: Hero ─────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6 pb-24 pt-32 text-center">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-0 h-[600px] w-[900px] -translate-x-1/2 rounded-full bg-sky-600/10 blur-[120px]" />
        <div className="absolute left-1/4 top-1/3 h-[400px] w-[400px] rounded-full bg-violet-600/8 blur-[100px]" />
      </div>

      {/* Badge */}
      <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-sky-500/30 bg-sky-500/10 px-4 py-1.5 text-xs font-medium text-sky-400">
        <Sparkles className="h-3.5 w-3.5" />
        AI-powered phone intake · Available 24/7
      </div>

      {/* Headline */}
      <h1 className="mx-auto max-w-3xl text-5xl font-bold leading-[1.1] tracking-tight text-white sm:text-6xl lg:text-7xl">
        Your AI receptionist.{" "}
        <GradientText>Always on.</GradientText>
      </h1>

      {/* Subheading */}
      <p className="mx-auto mt-7 max-w-xl text-lg leading-relaxed text-slate-400">
        Ava answers calls, qualifies leads, and notifies your team — 24/7,
        without missing a beat.
      </p>

      {/* CTAs */}
      <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
        <PrimaryButton href="/signup">
          Start Free Trial
          <ArrowRight className="h-4 w-4" />
        </PrimaryButton>
        <GhostButton href="#how">See How It Works</GhostButton>
      </div>

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
              { role: "ava", text: "Hi, this is Ava with Redwood Legal Group. I'll ask a few quick questions so the team can review your case. What's your name?" },
              { role: "caller", text: "Sarah Chen." },
              { role: "ava", text: "Thanks, Sarah. What type of legal matter are you calling about?" },
              { role: "caller", text: "A personal injury case — I was in a car accident last week." },
            ].map((msg, i) => (
              <div key={i} className={`flex gap-3 ${msg.role === "ava" ? "" : "flex-row-reverse"}`}>
                <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${msg.role === "ava" ? "bg-violet-500/20 text-violet-400" : "bg-slate-700 text-slate-400"}`}>
                  {msg.role === "ava" ? "A" : "C"}
                </div>
                <div className={`max-w-xs rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${msg.role === "ava" ? "bg-slate-800 text-slate-200" : "bg-sky-500/20 text-sky-200"}`}>
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
          Trusted by law firms, medical practices, and service businesses
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
      icon: <Sparkles className="h-6 w-6" />,
      step: "01",
      title: "We set up Ava for your business",
      desc: "Tell us about your business, services, and how you want leads handled. Ava is configured to match your brand and intake process in minutes.",
    },
    {
      icon: <Phone className="h-6 w-6" />,
      step: "02",
      title: "Forward your calls or get a new number",
      desc: "Point your existing number to Ava, or get a dedicated number. No hardware, no contracts — just a webhook and you're live.",
    },
    {
      icon: <Zap className="h-6 w-6" />,
      step: "03",
      title: "Ava handles intakes, you get notified instantly",
      desc: "Every call gets answered, every lead gets captured. You receive a detailed summary by email the moment a call ends.",
    },
  ];

  return (
    <section id="how" className="py-28 px-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-16 text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-sky-400">How it works</p>
          <h2 className="text-4xl font-bold tracking-tight text-white">
            Up and running in{" "}
            <GradientText>under 10 minutes</GradientText>
          </h2>
        </div>

        <div className="grid gap-8 md:grid-cols-3">
          {steps.map((s) => (
            <div key={s.step} className="group relative rounded-2xl border border-slate-800 bg-slate-900/60 p-8 transition-colors hover:border-slate-700">
              <div className="absolute right-6 top-6 text-5xl font-black text-slate-800 transition-colors group-hover:text-slate-700">
                {s.step}
              </div>
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-sky-500/15 text-sky-400">
                {s.icon}
              </div>
              <h3 className="mb-3 text-lg font-semibold text-white">{s.title}</h3>
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
      desc: "Use your existing business number or provision a new Twilio number. No new hardware or phone system required.",
    },
  ];

  return (
    <section className="py-28 px-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-16 text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-violet-400">Features</p>
          <h2 className="text-4xl font-bold tracking-tight text-white">
            Everything you need.{" "}
            <GradientText>Nothing you don't.</GradientText>
          </h2>
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          {features.map((f) => (
            <div key={f.title} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 transition-colors hover:border-slate-700">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/15 text-violet-400">
                {f.icon}
              </div>
              <h3 className="mb-2 text-base font-semibold text-white">{f.title}</h3>
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
    "Twilio webhook setup support",
    "Dashboard & call history",
    "Cancel anytime",
  ];

  return (
    <section className="py-28 px-6">
      <div className="mx-auto max-w-lg">
        <div className="mb-12 text-center">
          <p className="mb-3 text-sm font-semibold uppercase tracking-widest text-sky-400">Pricing</p>
          <h2 className="text-4xl font-bold tracking-tight text-white">
            Simple,{" "}
            <GradientText>honest pricing</GradientText>
          </h2>
          <p className="mt-4 text-slate-400">
            Everything included. No setup fees. Cancel anytime.
          </p>
        </div>

        <div className="relative rounded-2xl border border-sky-500/30 bg-gradient-to-b from-slate-900 to-slate-900/80 p-10 shadow-2xl shadow-sky-500/10">
          {/* Glow */}
          <div className="pointer-events-none absolute inset-0 -z-10 rounded-2xl bg-sky-500/5" />

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
                <CheckCircle2 className="h-4 w-4 shrink-0 text-sky-400" />
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
          <span className="h-2 w-2 rounded-full bg-violet-500" />
          <span className="text-sm text-slate-500">AI Intake Assistant</span>
        </div>
        <div className="flex items-center gap-6 text-sm text-slate-500">
          <Link href="/signup" className="transition-colors hover:text-slate-300">
            Get started
          </Link>
          <Link href="/login" className="transition-colors hover:text-slate-300">
            Sign in
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
          <span className="mb-0.5 h-2 w-2 rounded-full bg-violet-500" />
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
            className="rounded-full bg-sky-500 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-400"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Nav />
      <Hero />
      <SocialProof />
      <HowItWorks />
      <Features />
      <Pricing />
      <Footer />
    </div>
  );
}
