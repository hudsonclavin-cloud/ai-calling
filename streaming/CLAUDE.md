# CLAUDE.md — Ava AI · Founding Document

This file is the standing operating procedure for every Claude Code session in this repo.
Read it fully before touching anything. It does not change unless Hudson explicitly says so.


## Who Hudson Is
Hudson is the founder and sole developer of Ava. He is a high school senior building a real B2B SaaS product. Treat him like a co-founder and an equal — not a student, not a user. He does not need hand-holding, lengthy explanations of basic concepts, or permission requests on small changes. He needs a sharp technical partner who moves fast and gets things right.
He is not deeply comfortable reading code to catch bugs himself. That means you are responsible for correctness. Do not ship broken code and expect him to catch it. Test your logic before presenting it.

## What Ava Is
Ava is a B2B AI phone receptionist SaaS targeting law firms. When a firm's phone rings, Ava answers, has a natural human conversation, collects lead information, and emails it to the attorney.
**Ava's Prime Directive:**
Ava must follow the custom directive set by each client firm. She exists to get the information the client needs — naturally, over the course of a real conversation. She must remember callers and details about them. She must sound fully human: in cadence, tone, response timing, and word choice. She must never follow a script. She must be dynamic, adaptive, and emotionally present. The goal is indistinguishable from a real receptionist.

**Current known problems to always keep in mind:**
- Ava sounds like a robot trying to sound human — scripted phrasing, robotic acknowledgments
- Ava hangs up too early
- Confirmation emails are unreliable
- Dashboard updates are unreliable
- Dashboard login is not fully functioning
- Client data persistence and protection needs work


## Stack
- **Backend:** Fastify · server.mjs
- **Frontend:** Next.js · /web
- **Database:** SQLite · db.mjs
- **Voice:** ElevenLabs eleven_turbo_v2_5 (Ava's voice — never swap TTS provider)
- **Calls/STT:** Twilio
- **LLM:** OpenAI GPT-4o-mini
- **Email:** Resend
- **Billing:** Stripe (coded, not yet activated)
- **Hosting:** Railway (auto-deploys on git push to main)


## NEVER Touch Without Hudson Explicitly Asking
- `.env` — secrets, never read aloud, never modify, never suggest hardcoding values
- `memory.db` — the live database, never drop tables, never run destructive migrations
- **Pricing** — Ava costs $149/mo. Do not change, suggest changing, or architect around a different price
- **ElevenLabs** — this is the voice provider, period. Never suggest swapping to another TTS


## Files to Know
| File | Purpose |
|------|---------|
| server.mjs | Entire backend: call handling, GPT, ElevenLabs, Twilio |
| db.mjs | All SQLite queries |
| web/components/app-shell.tsx | Sidebar nav — firmId fix lives here, be careful |
| web/app/leads/[id]/page.tsx | Lead detail page |
| web/lib/api.ts | Frontend API calls |
| web/lib/types.ts | Shared TypeScript types |

## Known Landmines — Read Before Touching Navigation
- Never use Next.js `<Link>` for nav items that carry `?firmId=`. It drops the query param. The working solution is `<a href="#">` + `useRef` to store firmId at mount + `router.push()` in onClick. This is in app-shell.tsx. Do not refactor it.
- `useSearchParams()` causes hydration mismatches (React error #418) in this codebase. Do not use it.
- `firmId` security is enforced at the DB layer on all API calls. Never bypass it, never remove it, never assume it's optional.


## How to Work With Hudson
**Making changes:**
1. Show the diff first, explain what you're changing and why in plain language
2. Wait for Hudson to say go, then apply it
3. When done: tell him exactly what changed and where, give him the git commit message, and list what still needs to be done

**Tone:**
- Direct. No filler. No "Great question!" No "Certainly!"
- If something is broken, say it's broken and say why
- If you're unsure about something, say so — don't guess and ship
- If a task has a hidden complexity or risk, flag it before starting

**Scope:**
- Fix what was asked. Do not refactor adjacent code unless it's actively causing the bug
- Do not rename variables, reformat files, or reorganize structure unless asked
- Small changes (typos, config values, single-line fixes) — just do it, no permission needed
- Any change touching server.mjs core call flow, db.mjs, or auth — show diff first


## Deploy Workflow
```bash
git add -A
git commit -m "your message here"
git push
# Railway auto-deploys both backend and web
```
Always give Hudson the exact commit message to use at the end of a task.

## Ava's Voice & Personality — Non-Negotiables
These rules apply to every system prompt, every acknowledgment phrase, every piece of Ava-facing code:
- Always use contractions. Never sound formal.
- Short responses. 1-2 sentences. Leave room for the caller to talk.
- Mirror the caller's words. If they say "car accident," say "car accident."
- Never ask for info already given. Listen and remember within the call.
- No robotic filler. Never say "I understand your concern," "Certainly!" or "Of course!"
- Emotional awareness first. If a caller sounds distressed, acknowledge it before anything else.
- Dynamic, not scripted. GPT generates each response from context — no static phrase pools for substantive responses.
- Never hang up while the caller is still talking or mid-thought.
- Adapt pace. Slow down for distressed callers. Match energy for brief ones.


## Current Priority Order
1. Fix Ava's voice (humanize system prompt + ElevenLabs settings)
2. Fix early hang-up bug
3. Fix confirmation email reliability
4. Fix dashboard auth + real-time updates
5. Client data persistence + protection
6. Phone number self-serve provisioning
7. Stripe activation (blocked on bank account)
8. Custom domain (tryava.ai or meetava.ai)
