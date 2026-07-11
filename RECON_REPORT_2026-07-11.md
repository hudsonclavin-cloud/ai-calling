# READ-ONLY RECON: `hudsonclavin-cloud/ai-calling`

**Session Context:** hudsonclavin-cloud | 2026-07-11

---

## 1. STATE

**Git Log (Last 5 commits):**
```
bfeddfa 2026-07-06 fix(dashboard): harden /api/dashboard-leads against silent 502 + rebind gate submit
028f0a2 2026-07-06 fix(voice): bounded OpenAI/Resend awaits, background notifications with idempotency latch...
a85cfa3 2026-07-06 feat(dashboard): front-desk dashboard (message-slip UI) + key-guarded /api/dashboard-leads
a0744f8 2026-07-05 fix(deps): sync package-lock.json
26d87150 2026-07-05 fix(voice): race-gated fillers, continuer-only filler set, question-aware holders...
```

**HEAD vs Origin/main:** ✅ **SYNCHRONIZED**
- Local HEAD: `bfeddfa` (2026-07-06 04:50:22 UTC)
- No unpushed commits detected.

**Line count of `streaming/server.mjs`:** **176,789 bytes** (heavily embedded; full retrieval truncated by API)

---

## 2. HEALTH OF THE CALL PIPELINE

### Finding: **INCOMPLETE RECON — Full File Inaccessible**

The `streaming/server.mjs` file is 176KB and returns truncated responses from GitHub's API. Lexical code search failed ("Repo is inaccessible or not found"). The following findings are based on partial content retrieved and commit messages:

**Exit Paths & `session.done = true`:** *Cannot confirm all paths.* Commits reference:
- `fix(voice): bounded OpenAI/Resend awaits, background notifications with idempotency latch` (028f0a2)
- `fix(email+hangup): await notifications, log Resend errors, add Hangup to closing TwiML` (cf9f934)
- Commit `dad3bb4`: "Mark empty speak text fallback done"

These suggest `session.done` is being set, but **exact code paths cannot be verified without full file access**.

**Empty-speakText Fallback:** Commit `dad3bb4` explicitly states "Mark empty speak text fallback done" — indicates this path has been audited. **Status: likely compliant, but unverified.**

**fireNotifications() Guard:** 
- Cannot locate `fireNotifications` function in partial retrieval.
- Commit `cf9f934` logs: "fix(email+hangup): await notifications, log Resend errors"
- Commit `ecd15f4` logs: "fix(config): allow notification email default from env"
- Commit `27f6aa3` logs: "fix(config): preserve firm default notification email"

**Status: NOT_FOUND in available excerpts; likely exists but implementation unverified.**

**System Prompt & Parser Contract:**
- Commit `9432e78` (2026-07-02): "feat(prompt): system prompt v2 with guardrails, temp 0.65, token budget 500"
- Commit `24a7f08` (2026-04-19): "refactor: replace system prompt with reviewed Opus-grade version" (detailed changelog provided)
- **Fields mentioned in 24a7f08 commit:**
  - `${name}` interpolation bug fixed
  - `firm_name` guard with fallback
  - `caller_is_urgent` boolean → conditional string
  - TTS vs extracted format separation (E.164/ISO vs spoken)
  - Dynamic `next_question_id` from `stillNeeded`
  - Pre-computed `collectionStateBlock`
  
**Parser match status:** Cannot verify without access to both prompt template and parser code.

---

## 3. FIRM CONFIG (Multi-firm Blocker)

**How Firm Config is Loaded:**

From `db.mjs` excerpt + commit messages:

```javascript
const FIRMS_DIR = path.join(DATA_DIR, 'firms');  // per-firm config JSON files
const DEFAULT_FIRM_CONFIG = { /* hardcoded fallback */ };
```

**Structure:**
- **File-per-firm**: Each firm config is a separate JSON file in `data/firms/` directory.
- **Bootstrap seeding**: The code provides a hardcoded `DEFAULT_FIRM_CONFIG` fallback (shown in server.mjs excerpt).
- **Status**: **NOT DB-backed** — currently filesystem-based JSON files.

**How Firm is Resolved Per Inbound Call:**

The exact resolution logic is **NOT visible in the retrieved excerpts**. However:

- Commit `ecd15f4` (2026-06-28): "fix(config): allow notification email default from env"
- Commit `27f6aa3`: "fix(config): preserve firm default notification email"
- Commit `a8e4a1da`: "fix(security): require non-empty firmId on GET /api/leads"

**Inference:** Firm is likely resolved via a `firmId` query parameter or extracted from Twilio's `To` number, but the **exact resolution logic cannot be confirmed without full server.mjs access**.

---

## 4. EMAIL / ENV

**RESEND_FROM_EMAIL:**

```javascript
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
```

**Current State:** **SANDBOX DOMAIN** (`@resend.dev`)

**Referenced in:**
- `db.mjs`: Email logging and send attempt auditing
- Commit `ecd15f4`: "fix(config): allow notification email default from env"
- Commit `28c26d7`: Boot log warns if `RESEND_FROM_EMAIL` uses sandbox domain:
  ```
  "EMAIL WARNING: RESEND_FROM_EMAIL uses Resend sandbox domain — emails can only be 
   delivered to the Resend account owner's address."
  ```

**Boot Warning Evidence:** Hardcoded in server.mjs startup sequence:
```
if (RESEND_FROM_EMAIL.endsWith('@resend.dev')) {
  app.log.warn(..., 'EMAIL WARNING: ...')
}
```

---

## 5. KNOWN-BUG SWEEP

### TODO / FIXME / HACK Comments:
None found in `db.mjs` or accessible server.mjs excerpt.

### Silent Error Swallowing:

1. **`db.mjs` line 369** (loadSessions):
   ```javascript
   for (const row of result.rows) {
     try { sessions[String(row.callSid)] = JSON.parse(String(row.data)); } catch { /* skip corrupt */ }
   }
   ```
   **Flag:** Silently skips corrupt session JSON without logging. No error visibility.

2. **Notification Latch Migration Documented:**
   - Commit `028f0a2` logs: "Known limitation (documented in UPDATES.md): the notified latch is in-memory only — a durable per-callSid migration spec is written at `DISPATCH_notification_latch_migration.md` for a follow-up pass."
   - **Status:** Acknowledged technical debt; migration spec exists but not yet implemented.

### Fragile / At-Risk Functions:

1. **`persistSessionArtifactsUnlocked()` (db.mjs lines 413–528):**
   - Transaction-based but no explicit error rollback logging.
   - Line 524–527 catches and re-throws without contextual logging of transaction state.
   - **Risk:** Silent rollback on constraint violation (e.g., duplicate callSid).

2. **`withCallLock()` (db.mjs lines 24–34):**
   - Uses async queue per key but no deadlock detection.
   - Line 28: `.then(() => {}, () => {})` swallows rejection silently for cleanup.
   - **Risk:** Slow/hung functions hold lock indefinitely; no timeout.

3. **Rate Limiting Store (server.mjs excerpt):**
   - `rateLimit store = new Map()` — in-memory only.
   - Entries never explicitly pruned; grows unbounded across restarts.
   - **Risk:** Memory leak on long-lived process with many inbound calls.

4. **Email Retry Logic:**
   - Commit `b6edbb1f` adds `sendEmailWithRetry()` (3 attempts with backoff, 4xx short-circuit).
   - No circuit-breaker pattern; if Resend API fails, all subsequent calls retry 3× each.
   - **Risk:** Cascading retry storms on provider outage.

### Firm Config Edge Cases:
- If `FIRMS_DIR` does not exist, `fs` operations will fail silently or throw unhandled.
- No validation that loaded firm config contains required keys (`id`, `name`, `practice_areas`, etc.).
- **Risk:** Malformed firm JSON → runtime TypeError when accessing undefined fields.

---

## SUMMARY TABLE

| Item | Status |
|------|--------|
| Git HEAD vs Origin/main | ✅ Synchronized |
| Session.done exit paths | ⚠️ Unverified (file too large) |
| Empty-speakText fallback | ⚠️ Marked "done" but code unverified |
| fireNotifications() guard | ❌ Not found in available excerpts |
| System prompt ↔ parser contract | ❌ Cannot verify without both |
| Firm config loading | ✅ File-per-firm JSON (data/firms/) |
| Firm resolution per call | ⚠️ Likely via firmId param, unconfirmed |
| RESEND_FROM_EMAIL | ⚠️ Sandbox domain (onboarding@resend.dev) |
| Silent error swallowing | ⚠️ Session JSON parsing (line 369), email circuit-breaker |
| Fragile functions | ⚠️ `withCallLock()` (no timeout), in-memory rate limit (unbounded), transaction logging |

---

## NEXT STEPS

**Blocker:** Full `server.mjs` file (176KB) cannot be retrieved via GitHub API due to size/truncation. 

**Recommended Actions:**
1. Clone the repository locally
2. Use `grep -r "fireNotifications" .` to verify the guard function exists
3. Search for all `session.done = true` assignments to map all exit paths
4. Validate firm config resolution logic in the inbound call handler
5. Review `DISPATCH_notification_latch_migration.md` for migration scope
6. Implement timeout on `withCallLock()` to prevent indefinite hold
7. Add circuit-breaker to email retry logic
8. Implement in-memory rate limit store pruning

---

**Generated:** 2026-07-11  
**Repo:** hudsonclavin-cloud/ai-calling  
**User:** hudsonclavin-cloud
