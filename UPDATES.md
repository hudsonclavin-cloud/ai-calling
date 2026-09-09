# Ava — Update Log
> This file is maintained by Claude Code. Update it at the end of every session.
> It tells Claude Code what has already been solved so we never repeat work or lose context.

---

## Open Problems (not yet fixed)
- **No per-firm client authentication** — `?firmId=` in the URL is the only thing standing between a
  visitor and a firm's leads, and firm ids are derived from the business name (`firm_` + slug), so they
  are guessable. Every `/api/leads`, `/api/calls` and `/api/analytics` read is scoped by firmId but not
  authenticated by it. Firm-config *writes* and the admin routes are now behind the admin key, so
  self-service settings editing is admin-only until a real client credential exists. **This is the
  largest remaining hole and the next thing to build**: issue each firm a random secret at creation,
  require it on every `/api/*` call for that firm, and put it in the dashboard link you send clients.
- **DATA_DIR must point at a Railway volume** — if it does not, the lead database, the per-firm configs
  and the TTS cache all live in the build directory and are destroyed on every deploy. The server now
  logs this loudly at boot. Verify it before trusting anything else.
- **ROTATE the OpenAI and ElevenLabs keys** — `ai-calling.zip` was tracked and contained
  `streaming/.env` with live keys; `streaming/memory.db` contained a real caller's phone number and
  transcript. Both are untracked now and archives/databases are gitignored, but they remain in the
  repository's git history, so the keys must be considered compromised.
- **Stripe not activated** — billing is coded but blocked on the bank account. Note that checkout does
  not propagate firmId to the Subscription, so `subscription.updated` cannot match a firm; fix before
  activating or a paying customer's line auto-suspends when their trial ends.
- **Twilio Gather architecture** — the request/response design has a per-turn floor of roughly 1.5-2s
  and cannot capture speech while Ava is "thinking". The fixes below remove the artificial latency on
  top of that floor, but going materially below it means Media Streams or ConversationRelay.
- **Custom domain** — tryava.ai / meetava.ai not configured.

---

## Session Log (newest first)

### 2026-09-08 — Full-system audit and repair: 18 read-only lenses, 303 findings, 10 fix commits
**Why:** a year of fixes had not converged; calls still failed in ways the logs did not explain.
Eighteen independent read-only agents audited the call path, controller, prompt/parser contract, TTS,
recording, database, notifications, dashboard, landing page, deployment, tests, security, concurrency,
Twilio semantics, latency, git history, a caller walkthrough, and the architecture itself. Every fix
below was reproduced before and after the change.

**The defect that explains "she doesn't listen":** on the very first turn `composeSpeakText` spoke only
the greeting while the controller had already recorded the name question as asked. Ava never asked for
the caller's name, attributed their first answer to the wrong field, and the `askedQuestionIds` guard
then blocked her (and the model) from ever asking for it again — so she asked for a phone number first,
discarded the name when volunteered, jumped to "anything else?" with everything still empty, and only
circled back to the name at the end, where she looped. The same spoken-versus-recorded split existed on
later turns: Ava spoke the model's question but recorded the deterministic one, so the caller's answer
was graded against a field they were never asked about.

**Conversation**
- First turn now speaks the question it records. The shipped opening is a greeting again, not the IVR
  monologue the log claimed had been removed in March.
- The recorded question follows the spoken words, accepting the model's question id when it names a
  real field. The low-confidence clarification and the divergence question were being computed,
  recorded and then never spoken; they are now spoken.
- A still-empty core field is re-asked once, rephrased, instead of being dropped for "anything else?".
- The model may ask again for a field that is genuinely still missing.
- A name given while Ava is asking for a number is captured instead of discarded.
- `"My name's Maria"` (the contraction people actually say) is extracted; accented and non-Latin names
  are accepted instead of producing a nameless lead; `"that's everything"` is no longer stored as a name.
- Urgency detection no longer deletes an already-captured summary, so the most urgent call of the day
  stops arriving with an empty one.
- A blocked caller ID no longer matches every other anonymous caller, so Ava stops greeting strangers
  by a previous caller's name.
- Confirming the number you are calling from now counts as giving a callback number.

**Hanging up**
- `repromptCount` was only ever incremented: two pauses anywhere in a call ended it. Speaking clears it,
  and the allowance is 3, because an empty SpeechResult also means Twilio could not transcribe.
- Rate limiting counted webhook requests, not calls — a normal 8-turn intake spent 8 units of quota and
  the per-IP key is Twilio's shared egress address, not a caller. Only new calls are counted, and a call
  in progress can never be rejected.
- `detectEarlyExit` treated "I'm done with my husband, I want a divorce" as a goodbye.
- When the model wanted to close but a required field was missing, Ava spoke its goodbye and then held
  the line open in silence.
- An exception in `/twiml` hung up; it now speaks and keeps listening. Provisioned numbers get a
  VoiceFallbackUrl and there is a dependency-free `/twiml-fallback` behind it.
- `/twiml-result` returned an HTTP 500 on a rejected controller, and ended the call outright when its
  in-memory pending entry was missing (any redeploy). Both now recover.

**Voice**
- `speakText` carried SSML, so `<break>` tags counted against the character budget and truncated normal
  replies mid-sentence — dropping the question the caller needed to hear — and the tags were stored in
  transcripts, replayed to the model as history and shown to the attorney. Markup is applied only at the
  ElevenLabs call now.
- The TTS prefetch synthesized a different string than the one spoken, so it missed on nearly every turn
  and the caller waited on a second, serial synthesis. Prewarm warmed strings Ava never says.
- An empty `ELEVEN_*` variable set stability, similarity, style and speed to zero. Blank now means unset.
- `<Say>` fallbacks used Twilio's default male voice; the boot log reported settings that were not the
  ones being sent; `/tts-live` URLs did not change when the voice did, so Twilio replayed the old voice.
- An ElevenLabs outage produced dead air; consecutive failures now fall back to `<Say>`. Lost cached
  audio regenerates from self-authenticating fallback text instead of 404-ing into silence.
- `stripLeadingProhibitedAck` decapitated real sentences: "Great question —" became "Question —".

**Data**
- **Concurrent calls were losing almost every lead.** 40 simultaneous completed calls produced 39
  SQLITE_BUSY errors, 39 lost leads, and a connection that then refused every later write for the life
  of the process. Writes are now serialized through one queue; the same test loses nothing.
- Whole-table session writes let two callers revert each other's state; single-row get/save now.
- Lead identity was a hash of firm + caller phone, so a repeat caller overwrote their own earlier lead
  and merged both transcripts. Leads are per call.
- A silent call was stamped intake_complete and emailed as a lead; `/call-status` then re-promoted the
  ones the reprompt path had deliberately filed as partial.

**Email**
- The `notified` latch was set after the session row was written, so it never persisted and the grace
  window could send the attorney a second copy of the same lead.
- The early-exit path saved a completed lead and notified nobody.
- The reprompt path awaited the email inside the Twilio webhook, where Resend's retries can outlast
  Twilio's budget and drop the call.
- Lead emails linked to the dashboard without firmId, bouncing the attorney to the admin login.

**Recording**
- Recording never started: `Record` and `RecordingStatusCallback` were sent to the Call *update*
  endpoint, which has no such parameters. Twilio ignores unknown fields and returns 200, and the
  response was never inspected — which is why a year of debugging produced no signal. Recording now uses
  the Recordings sub-resource with a retry, and every Twilio response is checked.
- The playback proxy ignored Range requests, so recordings would not play in Safari or on iOS.

**Dashboard and website**
- There was no CORS anywhere, and the dashboard and API are separate services, so every browser-side
  fetch was blocked: leads, calls and dashboard lists sat empty and settings saves did nothing, while
  server-rendered pages worked — which is why it looked intermittent.
- The settings page loaded and saved `firm_default` for every client, so a firm editing its settings was
  rewriting the fallback config that unknown firmIds inherit.
- Every tone selector offered values that were not `TONE_PRESETS` keys, so the setting did nothing.
- `getLeadById` and `patchLead` dropped firmId, and the backend treated it as optional.
- The landing page's main call to action dialled a 555 number, which cannot ring.

**Security**
- Unauthenticated `POST /api/firms/:id` let anyone redirect a firm's lead emails and webhooks.
- `requireAdminKey` failed *open* when `ADMIN_API_KEY` was unset.
- The admin key was shipped to browsers via `NEXT_PUBLIC_ADMIN_KEY`; privileged calls now go through a
  same-origin server proxy that holds it.
- Closed: the open email relay, SSRF with read-back, unauthenticated number purchase and Stripe portal,
  path traversal in firm ids and in the audio cache key, and unauthenticated ElevenLabs synthesis.
- A new firm inherited the default firm's notification email and webhook.

**Deployment**
- A trailing slash on `PUBLIC_BASE_URL` made every TwiML URL a 404. Signature rejection answered Twilio
  with JSON instead of speech. There were no `unhandledRejection`/`uncaughtException` handlers, so one
  bad call could kill the process and Railway's retry limit could take the line down for good.
- Boot now names each misconfiguration and the symptom it causes. `.env.example` documents all 30
  variables (it documented 12); `web/.env.example` added.

**Adversarial review of this branch's own diff.** Six reviewers read the changes independently and
found real defects in them, all since fixed: the late-name-capture rule accepted any short digit-free
reply on the callback turn as the caller's legal name ("Hold on please" became a client's name — worse
than the bug it replaced); requiring firmId on the lead route broke the dashboard's transcript panel;
moving the admin key server-side left the admin's own pages empty, because those pages fetch from the
browser and the browser no longer has a credential; the notification latch was a plain boolean, so a
caller who corrected a detail in the grace window left the attorney holding the first, wrong version;
and making recording actually work turned a dormant compliance problem into a live one, so the default
opening now carries a recording notice. The review also caught pre-existing bugs the first pass missed:
tenant contact fields were stripped on write but merged back in from firm_default on read, so a firm
without its own notification phone sent lead SMS to the default firm's number; `GET /api/firms`
published every firm id and notification address unauthenticated, and the firm id is the only thing
protecting that firm's leads; signature rejection answered 403, which Twilio never plays; and partial
calls showed "In Progress" on the dashboard forever.

**Tests:** 75 → 104, all passing. Added `test/call-flow.test.mjs` (23 tests driving the server the way
Twilio does — nine of the first ten fail against the commit this branch started from) and
`test/llm-contract.test.mjs` (the first tests in this repo to exercise the model path at all; the
discarded-summary defect was found by them, not by reading). `npm test` no longer runs a
credentials-dependent script as if it were a test suite.

**Still to do, highest first:** per-firm client authentication; confirm DATA_DIR is a volume; rotate the
leaked keys; the simulation harness still tolerates the desync it was adapted to and gates nothing in CI.

### 2026-07-06 — Dashboard `/api/dashboard-leads` 502: harden the data path
**Symptom:** `/dashboard` HTML loaded but clicking Open returned a 502 from the Railway edge with NO application logs. Local reproduction returned 200 — but only because the local DB was empty; the real-row path was never exercised.
**Changed (`streaming/db.mjs` + `streaming/server.mjs`):**
- `listLeadsForDashboard` now maps rows through the shared `parseLead` (same as `loadLeads`) instead of returning raw libsql row values. Raw values risk non-JSON-serializable types (e.g. BigInt from INTEGER columns) that throw during Fastify serialization → which surfaces on the edge as a silent 502.
- The `/api/dashboard-leads` handler now wraps the DB read in try/catch + an 8s timeout (`DASHBOARD_DB_TIMEOUT_MS`), so a stalled or throwing query returns a **logged** 500 fast instead of hanging until the edge 502s. `/dashboard` got a try/catch too.
**Verified:** booted locally, seeded a realistic lead (INTEGER + JSON-string columns) into the dev DB, confirmed 200 with fully-coerced JSON, then removed the seed. **Note:** since the code reproduces as 200, this hardens the failure surface and — critically — makes any remaining prod failure LOGGED and diagnosable rather than silent. If it still 502s after deploy, the Railway log will now name the cause (and the older `/api/leads` route reading the same table is the comparison probe).

### 2026-07-05 — Dashboard gate button unresponsive: belt-and-suspenders rebind
**Changed (`streaming/dashboard.html` only):** the admin-key gate's "Open" button did nothing on click (no fetch, no console error). File integrity was clean (682 lines, LF-only, no CRLF) — the cause was upstream of the file itself. Fix: extracted the submit logic into a shared `submitGate()` guarded by an in-flight flag, and wired it to three independent triggers — form submit, direct button click, and Enter keydown on the key input — so the gate unlocks even if one event path is being swallowed.

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
