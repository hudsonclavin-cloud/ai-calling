# Ava — Update Log
> This file is maintained by Claude Code. Update it at the end of every session.
> It tells Claude Code what has already been solved so we never repeat work or lose context.

---

## Open Problems (not yet fixed)
- **Stripe not activated** — billing is fully coded but blocked on Hudson's bank account
- **Custom domain** — tryava.ai or meetava.ai not yet configured
- **Confirmation email reliability** — was on the known problems list; no explicit fix was ever committed
- **Non-admin sign-out** — `app-shell.tsx` uses `<Link href="/login">` for non-admin clients instead of `signOut()`, which may not fully terminate the NextAuth session
- **Ava voice naturalness** — SSML enrichment + voice settings tuned (2026-03-26); real-world Twilio call testing still needed to confirm audible improvement
- **Tone setting** — toneInstruction bug fixed; firms can now actually use warm/professional/friendly

---

## Session Log (newest first)

### 2026-07-05 — Caller-audible hotfix: timeouts, notification latch, live stream delta, audible errors
**Changed (`streaming/server.mjs` only):**
- EDIT 1: fixed the Responses-API stream delta read (`event.delta` is a string) → early-stream text extraction works, streaming actually helps latency.
- EDIT 2/3: bounded the OpenAI fetch (`OPENAI_TIMEOUT_MS` default 8000) and the Resend `resendPost` fetch (`RESEND_TIMEOUT_MS` default 5000) with `AbortSignal.timeout` — no more unbounded caller-side dead air; retry backoff `[0,1000,4000]` unchanged.
- EDIT 4: speech-path `fireNotifications` is now fire-and-forget (`.catch` logs `fireNotifications background failure`) — the goodbye no longer waits on the email. (persist ordering unchanged: `saveSessions` + fire-and-forget artifacts already ran before it.)
- EDIT 5: added a `notified` idempotency latch (`createSession` + guard/set inside `fireNotifications`).
- EDIT 6: `holdKey` ("One moment please.") now substitutes ONLY when `speakText` is empty — error/rate-limit/timeout messages are audible for the first time (via `/tts-live` when a `liveUrl` is present, else `<Say>`).
- EDIT 7: question-turn `speechTimeout="1" → "auto"` (grace builder untouched) — recovers ~300-700ms/turn of endpointing tax; A/B by ear and revert one line if end-of-speech detection degrades.
- EDIT 8: retired the adaptive filler — removed `buildAdaptiveFiller`/`extractCallerTopic` (both had a single call site); every filler now resolves to a prewarmed key, so no live TTS and no parroted STT ("Oh — <your words>. One sec.") on the filler path.
**Known limitation / follow-up:** the EDIT 5 latch is in-memory only. On both fire sites `saveSessions` runs before `fireNotifications`, so `notified=true` (set inside `fireNotifications`) is not persisted that turn — a grace re-trip that reloads the session sees `notified:false` and can still duplicate. Full cross-request idempotency needs `notified` persisted (e.g., set it before the pre-fire `saveSessions`, guarded so the send still fires, or a module-level notified-set). Flagged, not fixed in this pass.

### 2026-07-05 — Front-desk dashboard shipped (backend-served, key-guarded)
**Changed:**
- Added `streaming/dashboard.html` — standalone message-slip front-desk UI (inert without the admin key; polls the data endpoint every 30s).
- `streaming/db.mjs`: new read-only `listLeadsForDashboard(firmId, limit)` — parameterized `SELECT * FROM leads WHERE firmId=? ORDER BY updatedAt DESC LIMIT ?`, returns plain column-keyed objects with JSON columns left as strings for the client to parse.
- `streaming/server.mjs`: `GET /api/dashboard-leads` (requires `x-admin-key`; 503 if `ADMIN_API_KEY` unset, 401 on mismatch, never logs the key) + `GET /dashboard` (serves the HTML via `fs.readFile` from `__dirname`).
- Note: no `/demo` route existed to mirror, so the page is served from the streaming backend directly (required anyway — it fetches `/api/dashboard-leads` same-origin).
**Follow-up:** the endpoint returns PII behind a single shared admin key — replace with the Cluster F per-firm auth layer when it lands.

### 2026-07-03 — Six-agent backend audit + concurrency deadlock fix shipped
**Changed:**
- `streaming/db.mjs`: Split `persistSessionArtifacts` into a lock-free `persistSessionArtifactsUnlocked` delegate; the public `persistSessionArtifacts` now wraps it in `withCallLock` (commit `cdcee5a`)
- `streaming/server.mjs`: `/call-status` now calls `persistSessionArtifactsUnlocked` inside its own `withCallLock(callSid)` body (was re-entering the same lock → deadlock); `/recording-status` falls back to `getCallByCallSid()` when the session row is already deleted (commit `cdcee5a`)
- Pushed `cdcee5a` to `origin/main` → Railway auto-deploy
- Ran a read-only six-lens audit of the streaming backend; full findings written to `ava-audit-report.md` (repo root, untracked — not committed)
**Fixed:**
- **R1 (P0):** `withCallLock` re-entrancy deadlock — every completed call was hanging the partial-lead persist, `deleteSession`, and recording save. Confirmed by two independent audit agents (one reproduced it empirically). This is the root cause behind "confirmation emails unreliable," "dashboard updates unreliable," and session rows accumulating.
- **R20 (P1):** recording URL was dropped when Twilio's recording callback arrived after the session was deleted — now recovered via the calls table.
**Still broken / needs follow-up (from the audit, highest first):**
- **R3 (P0):** the live `speakText was empty` (C2) bug is fully traced — done-gate diverges from the question generator, poisons `lastQuestionId=null`, an empty ghost turn is misrouted as a first turn → duplicate goodbye + falsely marks lead `intake_complete`. Falsification test is in the report; run it before fixing. This is the "hangs up too early" bug.
- **R4 (P0):** Stripe checkout metadata never reaches the Subscription object → `subscription.updated` no-ops → a paying customer's line auto-suspends on trial day 8. Fix before Stripe activation.
- **R2 (P0):** whole-table `loadSessions`/`saveSessions` clobbers concurrent calls' rows. Needs single-row `getSession`/`saveSession` helpers.
- **R5–R8 (P1 security):** unauthenticated `/api/*` routes let a guessed firmId buy Twilio numbers, cancel subscriptions, read cross-tenant PII/secrets, and SSRF. Part of "client data persistence + protection."
- **R11–R13, R14/R15/R21:** dead early-TTS path (`event.delta` shape), "One moment please." shadowing real questions on TTS failure, dropped bare-name answers, and caller-ID laundering / lead-sharing. See `ava-audit-report.md` for the full ranked list and root-cause clusters.

---

### 2026-03-26 — Ava human voice upgrade (prosody, SSML, voice settings)
**Changed:**
- `streaming/server.mjs`: Expanded filler phrase pool from 5 → 10 phrases (more variety between turns)
- `streaming/server.mjs`: Replaced `addNaturalPauses()` with `enrichForSpeech()` — handles post-ack pauses, em-dash/en-dash mid-thought breaks, ellipsis trailing-off, comma clause pauses, phone number → spoken digits, and dollar amounts → words
- `streaming/server.mjs`: Added `numberToWords()` helper for dollar amount conversion
- `streaming/server.mjs`: Updated `<Say>` TwiML fallback in both `gatherTwiml` and `doneTwiml` to strip SSML tags before xmlEscape (prevents literal `<speak>` text on ElevenLabs outage)
- `streaming/server.mjs`: Tuned ElevenLabs voice settings (both `synthesizeToDisk` and `/tts-live`): stability 0.45→0.38, similarity_boost 0.85→0.80, style 0.20→0.38, speed 1.05→0.96
- `streaming/server.mjs`: Added TTS system prompt block instructing LLM to use em-dashes, ellipses, spelled-out numbers, and one-breath sentences
- `streaming/server.mjs`: Added model comment for `eleven_flash_v2_5` as future candidate
- `streaming/scripts/test-voice.mjs`: Synced TTS system prompt block into `buildSystemPrompt()`
**Fixed:**
- TTS was missing prosody cues — em-dashes and ellipses now trigger SSML breaks
- Phone numbers and dollar amounts were spoken as raw digits/symbols
- Voice sounded slightly fast and over-consistent — speed/stability/style tuned for warmer phone delivery
**Still broken / needs follow-up:**
- Real-world call testing needed to confirm audible improvement on Twilio G.711

---

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
