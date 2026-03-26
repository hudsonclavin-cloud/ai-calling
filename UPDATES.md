# Ava — Update Log
> This file is maintained by Claude Code. Update it at the end of every session.
> It tells Claude Code what has already been solved so we never repeat work or lose context.

---

## Open Problems (not yet fixed)
- **Stripe not activated** — billing is fully coded but blocked on Hudson's bank account
- **Custom domain** — tryava.ai or meetava.ai not yet configured
- **Confirmation email reliability** — was on the known problems list; no explicit fix was ever committed
- **Non-admin sign-out** — `app-shell.tsx` uses `<Link href="/login">` for non-admin clients instead of `signOut()`, which may not fully terminate the NextAuth session
- **Ava voice naturalness** — robotic ack bug fixed; real-world call testing still needed to confirm quality
- **Tone setting** — toneInstruction bug fixed; firms can now actually use warm/professional/friendly

---

## Session Log (newest first)

### 2026-03-25 — Eliminate robotic acknowledgments, fix voice naturalness (#1)
**Changed:**
- `streaming/server.mjs`: Fixed bug where `toneInstruction` was computed but never injected into the system prompt — tone setting was silently doing nothing
- `streaming/server.mjs`: Rewrote system prompt — now explicitly requires every `next_question_text` to open with a natural human acknowledgment; bans robotic phrases by name ("Of course.", "Sure thing.", "Absolutely.", "Certainly!", etc.)
- `streaming/server.mjs`: Removed `effectiveLlmAck` regex/length gate — previously any LLM response under 80 chars that didn't start with a narrow set of phrases got a deterministic ack like "Sure thing." prepended on top; now if the LLM returned any text, it's used as-is
- `streaming/server.mjs`: Fixed default opening — removed "I'm going to ask you a few quick questions" IVR phrasing
- `streaming/server.mjs`: Bumped temperature 0.7 → 0.8 for more varied phrasing
**Fixed:**
- Ava was saying "Sure thing. And who am I speaking with?" — deterministic ack bolted onto LLM text
- Tone configuration (warm/professional/friendly) had no effect — toneInstruction variable was a dead assignment
- Opening line sounded like an IVR system
**Still broken / needs follow-up:**
- Voice naturalness is better but real-world call testing needed to confirm
- Confirmation email reliability still not addressed

---

### 2026-03-25 — Self-serve phone number provisioning + onboarding bug fix
**Changed:**
- `streaming/server.mjs`: Added `GET /api/firms/:id/phone/search` — searches Twilio available numbers by area code
- `streaming/server.mjs`: Added `POST /api/firms/:id/phone/purchase` — purchases number, sets VoiceUrl webhook, persists `twilio_phone` to firm config
- `streaming/db.mjs`: Added `getLeadById`, made `DATA_DIR` configurable via env, hardened firmId scoping on `/api/calls`, `/api/leads`, `/api/leads/:id/transcript`, `/api/calls/:id/recording`, and `PATCH /api/leads/:id`
- `web/components/firm-edit-form.tsx`: Added Phone Number card — shows assigned number read-only if set; otherwise shows area code search → pick → purchase flow
- `web/app/onboarding/page.tsx`: Fixed bug where `twilioPhone` collected during onboarding was never saved to firm config (`twilio_phone` field now included in `createFirm` payload)
**Fixed:**
- Firms can now self-serve provision a Twilio number from the Settings dashboard — no more manual Hudson provisioning
- Onboarding phone number was silently dropped; now persisted correctly
**Still broken / needs follow-up:**
- Stripe still not activated
- Custom domain still not configured

---

### 2026-03-25 — Dashboard auth bugs + real-time polling
**Changed:**
- `web/`: Fixed dashboard authentication flow; enabled 30s real-time polling on dashboard and leads pages
**Fixed:**
- Dashboard login was broken; firms couldn't access their data after auth
- Dashboard data was stale — now auto-refreshes
**Still broken / needs follow-up:**
- Non-admin sign-out may not fully clear NextAuth session (uses `<Link>` not `signOut()`)

---

### 2026-03 — Early hang-up fixes (multiple commits)
**Changed:**
- `streaming/server.mjs`: Added grace period before Ava can trigger hang-up; tightened "done" signal detection; added closing rules; prevented hang-up when caller auto-fills from caller ID; fixed question cap triggering early exit
**Fixed:**
- Ava was hanging up while caller was still mid-thought
- Caller ID data was prematurely completing intake fields
**Still broken / needs follow-up:**
- None specific to this area

---

### 2026-03 — CLAUDE.md + voice humanization + ElevenLabs tuning
**Changed:**
- `streaming/CLAUDE.md`: Created founding document with SOP, landmines, and priority order
- `streaming/server.mjs`: Rewrote OpenAI system prompt for fully human cadence; set Matilda voice (XrExE9yKIg1WjnnlVkGX); tuned speed 1.15, stability 0.20; switched to `eleven_turbo_v2_5`; added thinking filler phrases; added grace period; moved to streaming ElevenLabs endpoint; parallelized OpenAI + TTS for lower latency
**Fixed:**
- Ava sounded robotic; scripted acknowledgments replaced with LLM-generated responses
- Latency reduced via parallel OpenAI+TTS calls and streaming TTS endpoint
**Still broken / needs follow-up:**
- Voice naturalness still on priority #1 — ongoing

---

### 2026-03 — Billing, signup, and firm management
**Changed:**
- `streaming/server.mjs`: Added Stripe checkout + billing portal; `POST /api/billing/checkout`, `POST /api/billing/portal`, Stripe webhook handler
- `web/app/`: Added self-serve signup flow with Stripe payment gate + welcome email
- `web/app/clients/`: Admin page for listing and editing all firms
- `web/components/firm-edit-form.tsx`: Settings form for ava_name, tone, notification_email, twilio_phone, webhook URL, voice preview
- `web/app/onboarding/`: Multi-step onboarding flow for new firms
**Fixed:**
- No way to onboard firms without Hudson doing it manually
- No billing infrastructure
**Still broken / needs follow-up:**
- Stripe not activated (bank account)

---

### 2026-03 — Core feature build-out (foundation)
**Changed:**
- `streaming/server.mjs`: Full intake engine — question flow, GPT-4o-mini LLM, ElevenLabs TTS, Twilio call handling, returning caller detection, urgency path, voicemail detection, Whisper transcription, partial lead capture on hangup, webhook delivery, quality scoring, rate limiting, firmId DB isolation
- `streaming/db.mjs`: SQLite schema with libsql; calls, leads, sessions, webhook_logs tables; full CRUD
- `web/`: Dashboard with call rows, leads table (filterable, CSV export), analytics, admin analytics, system health indicator, auto-refresh, HTML notification emails, SMS notifications
- `web/lib/api.ts`: Full typed API client wrapping all backend routes
- `web/components/app-shell.tsx`: Sidebar nav with firmId-safe routing (uses `useRef` + `router.push` to preserve `?firmId=` — never use `<Link>` for nav items)
**Fixed:**
- Initial product build — nothing was working
**Still broken / needs follow-up:**
- Stripe not activated; custom domain; voice naturalness
