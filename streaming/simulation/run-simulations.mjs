// 40-call Ava simulation harness (MODE A: real /twiml routes via app.inject,
// authoritative state from the temp datastore). No Twilio/ElevenLabs/Resend/
// Stripe network calls. OpenAI is the only permitted external host.
//
// Usage:
//   node streaming/simulation/run-simulations.mjs --dry-run
//   node streaming/simulation/run-simulations.mjs --count 40 --concurrency 1
//   node streaming/simulation/run-simulations.mjs --only normal-intake-a,distress-a
//
// Nothing here prints the OpenAI key. External non-OpenAI requests are blocked.

import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STREAMING_DIR = path.resolve(__dirname, '..');
const REPO_DIR = path.resolve(STREAMING_DIR, '..');

// ── original stdout (for harness output that bypasses the server-log tap) ──────
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const say = (s) => realStdoutWrite(s + '\n');

// ── args ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { count: 40, concurrency: 1, dryRun: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--count') out.count = Number(argv[++i]);
    else if (a === '--concurrency') out.concurrency = Math.min(2, Math.max(1, Number(argv[++i]) || 1));
    else if (a === '--only') out.only = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

// ── environment isolation (MUST run before importing server.mjs) ───────────────
export async function isolateEnv() {
  // Load the real streaming/.env to obtain OPENAI_API_KEY (and anything else),
  // WITHOUT overriding vars already present in the shell.
  try {
    const dotenv = await import('dotenv');
    dotenv.config({ path: path.join(STREAMING_DIR, '.env') });
  } catch { /* dotenv optional; OPENAI_API_KEY may already be in the shell */ }

  // Preserve ONLY OpenAI (OPENAI_API_KEY, OPENAI_MODEL). Delete every other
  // production integration Railway may have injected — API keys, auth secrets,
  // and any datastore URL (the app uses a file: SQLite under DATA_DIR only, but
  // we delete DB/Postgres/Supabase/Redis vars anyway so no client can auto-connect).
  for (const k of BLANKED_ENV) delete process.env[k];

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ava-sim-'));
  process.env.DATA_DIR = tmp;                          // override Railway's /railway-data
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3000';
  process.env.NEXT_PUBLIC_API_BASE = 'http://127.0.0.1:3000';
  process.env.WEB_BASE_URL = 'http://127.0.0.1:3000';
  process.env.TWILIO_WEBHOOK_BASE_URL = 'http://127.0.0.1:3000/twiml?firmId=firm_default';
  process.env.SKIP_TWILIO_SIGNATURE_VALIDATION = 'true';

  const hasOpenAI = !!(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
  return { tmp, hasOpenAI, openAiKeyLen: (process.env.OPENAI_API_KEY || '').trim().length };
}

// Production integrations deleted before any application module is imported.
// (OPENAI_API_KEY and OPENAI_MODEL are deliberately absent — they are preserved.)
export const BLANKED_ENV = [
  'ADMIN_API_KEY', 'ADMIN_GITHUB_USERNAME', 'AUTH_GITHUB_ID', 'AUTH_GITHUB_SECRET', 'AUTH_SECRET',
  'ELEVENLABS_API_KEY', 'ELEVENLABS_MODEL_ID', 'ELEVENLABS_VOICE_ID',
  'ELEVEN_SIMILARITY', 'ELEVEN_SPEAKER_BOOST', 'ELEVEN_SPEED', 'ELEVEN_STABILITY', 'ELEVEN_STYLE',
  'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'NOTIFICATION_EMAIL',
  'STRIPE_PRICE_ID', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER',
  'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_USER', 'POSTGRES_PASSWORD',
  'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'REDIS_URL',
  'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
];

// ── fetch guard: allow only OpenAI; block/record everything else ───────────────
const blockedRequests = [];
export function isAllowedHost(host) { return host === 'api.openai.com'; }
function installFetchGuard() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url || String(input));
    let host = '';
    try { host = new URL(url).host; } catch { host = url; }
    const allowed = isAllowedHost(host);
    if (!allowed) {
      blockedRequests.push({ host, url: url.slice(0, 120) });
      throw new Error(`[sim] blocked external request to ${host} (only api.openai.com is allowed)`);
    }
    return realFetch(input, init);
  };
}

// ── server-log tap: capture [LLM-IN] and latency-trace, suppress noise ─────────
const llmIns = [];        // { callSid, systemPromptChars }
const latencyTraces = []; // { callSid, openai_ms, total_ms }
function installLogTap() {
  let buf = '';
  const handle = (chunk) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.tag === '[LLM-IN]' || o.msg === '[LLM-IN]') llmIns.push({ callSid: o.callSid, systemPromptChars: o.systemPromptChars });
      else if (o.type === 'latency-trace' || o.msg === 'latency-trace') latencyTraces.push({ callSid: o.callSid, openai_ms: o.openai_ms, total_ms: o.total_ms });
    }
  };
  process.stdout.write = (chunk, enc, cb) => { try { handle(chunk); } catch { /* ignore */ } if (typeof enc === 'function') enc(); else if (typeof cb === 'function') cb(); return true; };
  process.stderr.write = process.stdout.write;
}

// ── TwiML parsing ──────────────────────────────────────────────────────────────
export function xmlUnescape(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function stripBase(u) {
  const base = process.env.PUBLIC_BASE_URL || '';
  const dec = xmlUnescape(u);
  return dec.startsWith(base) ? dec.slice(base.length) : dec;
}
export function parseTwiml(xml) {
  const s = String(xml || '');
  const hasHangup = /<Hangup\s*\/>/.test(s);
  const gather = s.match(/<Gather\b[^>]*\baction="([^"]+)"/);
  const redirect = s.match(/<Redirect[^>]*>([^<]+)<\/Redirect>/);
  const gatherAction = gather ? xmlUnescape(gather[1]) : null;
  const redirectTarget = redirect ? xmlUnescape(redirect[1]) : null;

  if (hasHangup) return { kind: 'done', graceAction: gatherAction };
  if (gatherAction && !/\/twiml-grace/.test(gatherAction)) return { kind: 'ava_turn', actionPath: stripBase(gatherAction) };
  if (redirectTarget && /\/twiml-result/.test(redirectTarget)) return { kind: 'filler', redirectPath: stripBase(redirectTarget) };
  return { kind: 'unknown', raw: s.slice(0, 200) };
}

// ── HTTP-ish helpers over app.inject ────────────────────────────────────────────
function form(obj) { return new URLSearchParams(obj).toString(); }
async function postForm(app, url, body) {
  const res = await app.inject({
    method: 'POST', url,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form(body),
  });
  return { statusCode: res.statusCode, body: res.body };
}

// ── deterministic id helpers (exported for tests) ──────────────────────────────
export const MAX_CALLER_TURNS = 12;
export function callSidFor(runId, scenarioId) {
  return 'CA' + crypto.createHash('sha1').update(`${runId}|${scenarioId}`).digest('hex').slice(0, 32);
}
export function fromPhoneFor(index) {
  return `+1980555${String(1000 + index).slice(-4)}`;
}

// ── driving one call ────────────────────────────────────────────────────────────

async function driveCall({ app, db, scenario, callSid, fromPhone, firmId }) {
  const { createSimulatedCaller } = await import('./simulated-caller.mjs');
  const caller = createSimulatedCaller(scenario);
  const turns = [];
  let status = 'unknown';
  let failureReason = '';
  let callerTurns = 0;

  const readSession = async () => (await db.loadSessions())[callSid] || null;

  // advance() posts a caller utterance to /twiml and follows any filler redirect
  // to /twiml-result, returning the final parsed reply + total wall-clock ms.
  const advance = async (speechResult, confidence) => {
    const t0 = Date.now();
    let r = await postForm(app, `/twiml?firmId=${encodeURIComponent(firmId)}`, {
      CallSid: callSid, From: fromPhone, SpeechResult: speechResult ?? '', Confidence: confidence ?? '',
    });
    let parsed = parseTwiml(r.body);
    let hops = 0;
    while (parsed.kind === 'filler' && hops < 6) {
      r = await postForm(app, parsed.redirectPath, { CallSid: callSid });
      parsed = parseTwiml(r.body);
      hops++;
    }
    return { parsed, ms: Date.now() - t0, body: r.body };
  };

  try {
    // Inbound webhook (no SpeechResult) -> Ava's opening.
    let { parsed } = await advance('', '');
    let sess = await readSession();
    if (!sess) { return { status: 'infra-failure', failureReason: 'no session after inbound webhook', turns, transcript: [], finalSession: null }; }
    if (parsed.kind === 'done') { status = 'completed'; }

    while (parsed.kind !== 'done') {
      if (parsed.kind !== 'ava_turn') { status = 'malformed'; failureReason = `unexpected TwiML kind=${parsed.kind}`; break; }
      if (callerTurns >= MAX_CALLER_TURNS) { status = 'loop'; failureReason = 'reached max caller turns without completion'; break; }

      const questionId = sess?.lastQuestionId || '';
      const questionText = sess?.lastQuestionText || '';
      const r = caller.respond({ questionId, questionText });
      callerTurns++;

      const adv = await advance(r.text, String(r.confidence));
      const after = await readSession();
      turns.push({
        index: callerTurns,
        questionId,
        questionText,
        callerText: r.text,
        confidence: r.confidence,
        source: r.source,
        processingMs: adv.ms,
        collectedKeys: after ? Object.keys(after.collected || {}).filter((k) => after.collected[k]) : [],
        callback_number: after?.collected?.callback_number || '',
        phoneRetryPending: !!after?.phoneRetryPending,
        phoneRetryUsed: !!after?.phoneRetryUsed,
        isUrgent: !!after?.isUrgent,
        repromptCount: after?.repromptCount ?? 0,
        done: !!after?.done,
      });
      parsed = adv.parsed;
      sess = after;
      if (parsed.kind === 'done') { status = 'completed'; break; }
    }

    const finalSession = await readSession();
    const transcript = finalSession?.transcript || [];
    if (status === 'unknown') status = finalSession?.done ? 'completed' : 'incomplete';
    return { status, failureReason, turns, transcript, finalSession, callerTurns, unexpected: caller.unexpectedQuestions() };
  } catch (err) {
    return { status: 'infra-failure', failureReason: `exception: ${String(err?.message || err)}`, turns, transcript: [], finalSession: await readSession().catch(() => null), callerTurns };
  }
}

// ── seeding prior leads for returning-caller scenarios ──────────────────────────
async function seedPriorLead(db, firmId, fromPhone, prior) {
  const id = 'lead_' + crypto.createHash('sha1').update(`${firmId}|${fromPhone}`).digest('hex');
  const now = new Date(Date.now() - 3 * 86400000).toISOString();
  await db.saveLeads([{
    id, firmId, fromPhone,
    full_name: prior.full_name || '',
    callback_number: prior.callback_number || '',
    practice_area: prior.practice_area || '',
    case_summary: prior.case_summary || '',
    caller_type: 'returning',
    status: 'ready_for_review',
    lastCallSid: 'CAprior' + id.slice(5, 15),
    createdAt: now, updatedAt: now,
    transcript: [], timeline: [],
  }]);
}

// ── main ────────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const commit = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_DIR }).toString().trim(); } catch { return 'unknown'; } })();

  const env = await isolateEnv();
  if (!env.hasOpenAI) {
    say('FATAL: OPENAI_API_KEY not available (needed for Ava LLM calls). Set it in streaming/.env. Aborting.');
    process.exit(2);
  }
  installFetchGuard();

  // Load scenarios BEFORE tapping stdout so any JSON parse issues surface plainly.
  const scenariosDoc = JSON.parse(await fsp.readFile(path.join(__dirname, 'scenarios.json'), 'utf8'));
  let scenarios = scenariosDoc.scenarios;
  const firmId = scenariosDoc.firmId || 'firm_default';

  if (args.dryRun) {
    const dryIds = ['normal-intake-a', 'low-confidence-phone-a', 'distress-dv-a'];
    scenarios = scenarios.filter((s) => dryIds.includes(s.id));
  } else if (args.only) {
    scenarios = scenarios.filter((s) => args.only.includes(s.id));
  } else {
    scenarios = scenarios.slice(0, args.count);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-') + (args.dryRun ? '-dry' : '');
  const resultsDir = path.join(__dirname, 'results', runId);
  await fsp.mkdir(resultsDir, { recursive: true });

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const meta = {
    runId, commit, model,
    scenarioVersion: scenariosDoc.version,
    startedAt: new Date().toISOString(),
    dataDir: env.tmp,
    openAiKeyPresent: true, openAiKeyLen: env.openAiKeyLen,
    externalDisabled: ['ELEVENLABS', 'RESEND', 'TWILIO', 'STRIPE', 'NOTIFICATION_EMAIL'],
    concurrency: args.concurrency, count: scenarios.length, dryRun: args.dryRun,
  };

  installLogTap(); // from here, server logs are captured, not printed

  // Import the server (env already isolated) + db for authoritative reads.
  const mod = await import(pathToFileURL(path.join(STREAMING_DIR, 'server.mjs')).href);
  const app = mod.app;
  const db = await import(pathToFileURL(path.join(STREAMING_DIR, 'db.mjs')).href);
  await app.ready();

  const callsPath = path.join(resultsDir, 'calls.jsonl');
  const turnsPath = path.join(resultsDir, 'turns.csv');
  const callsStream = fs.createWriteStream(callsPath, { flags: 'a' });
  const turnsStream = fs.createWriteStream(turnsPath, { flags: 'a' });
  turnsStream.write('run_id,scenario_id,turn_index,question_id,caller_text,confidence,source,processing_ms,phone_retry_pending,phone_retry_used,is_urgent,reprompt_count,done\n');

  const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

  const runOne = async (scenario, index) => {
    const callSid = callSidFor(runId, scenario.id);
    const fromPhone = fromPhoneFor(index);

    if (scenario.prior_lead) await seedPriorLead(db, firmId, fromPhone, scenario.prior_lead);

    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const result = await driveCall({ app, db, scenario, callSid, fromPhone, firmId });
    const wallMs = Date.now() - t0;

    const traces = latencyTraces.filter((t) => t.callSid === callSid);
    const llmCount = llmIns.filter((l) => l.callSid === callSid).length;

    const collected = result.finalSession?.collected || {};
    const record = {
      runId, commit, model, scenarioId: scenario.id, family: scenario.family, variant: scenario.variant,
      startedAt, endedAt: new Date().toISOString(), wallMs,
      status: result.status, failureReason: result.failureReason || '',
      turnCount: result.callerTurns ?? result.turns.length,
      requiredFieldsExpected: scenario.expected?.fields || {},
      collected: {
        full_name: collected.full_name || '',
        callback_number: collected.callback_number || '',
        practice_area: collected.practice_area || '',
        case_summary: collected.case_summary || '',
      },
      done: !!result.finalSession?.done,
      isUrgent: !!result.finalSession?.isUrgent,
      repromptCount: result.finalSession?.repromptCount ?? 0,
      phoneRetryUsed: !!result.finalSession?.phoneRetryUsed,
      unexpectedQuestions: result.unexpected || [],
      llmCallCount: llmCount,
      llmLatencyMs: traces.map((t) => t.openai_ms).filter((n) => Number.isFinite(n)),
      processingLatencyMs: result.turns.map((t) => t.processingMs),
      transcript: result.transcript,
      turns: result.turns,
      expected: scenario.expected || {},
      persona: scenario.persona || {},
      description: scenario.description || '',
    };
    callsStream.write(JSON.stringify(record) + '\n');
    for (const t of result.turns) {
      turnsStream.write([runId, scenario.id, t.index, t.questionId, csvCell(t.callerText), t.confidence, t.source, t.processingMs, t.phoneRetryPending, t.phoneRetryUsed, t.isUrgent, t.repromptCount, t.done].join(',') + '\n');
    }
    say(`  [${index + 1}/${scenarios.length}] ${scenario.id.padEnd(24)} status=${result.status.padEnd(11)} turns=${record.turnCount} llm=${llmCount} wall=${wallMs}ms`);
    return record;
  };

  say(`\nRUN ${runId}  commit=${commit.slice(0, 7)}  model=${model}  calls=${scenarios.length}  concurrency=${args.concurrency}`);
  say(`DATA_DIR=${env.tmp}  (external services disabled; OpenAI only)\n`);

  const records = [];
  const conc = Math.max(1, Math.min(2, args.concurrency));
  for (let i = 0; i < scenarios.length; i += conc) {
    const batch = scenarios.slice(i, i + conc);
    const done = await Promise.all(batch.map((s, j) => runOne(s, i + j)));
    records.push(...done);
  }

  callsStream.end(); turnsStream.end();
  await new Promise((r) => callsStream.on('finish', r));
  await new Promise((r) => turnsStream.on('finish', r));

  meta.finishedAt = new Date().toISOString();
  meta.blockedExternalRequests = blockedRequests;
  meta.totalLlmCalls = records.reduce((a, r) => a + r.llmCallCount, 0);
  meta.avgSystemPromptChars = llmIns.length ? Math.round(llmIns.reduce((a, l) => a + (l.systemPromptChars || 0), 0) / llmIns.length) : 0;
  await fsp.writeFile(path.join(resultsDir, 'run-meta.json'), JSON.stringify(meta, null, 2));

  // Evaluate + write reports.
  const evalMod = await import(pathToFileURL(path.join(__dirname, 'evaluate-results.mjs')).href);
  const summary = await evalMod.evaluateRun(resultsDir);

  // OpenAI usage estimate (chars/4 heuristic).
  const estInputTokens = meta.totalLlmCalls * Math.ceil((meta.avgSystemPromptChars || 4000) / 4);
  const estOutputTokens = meta.totalLlmCalls * 180; // capped by max_output_tokens 500; typical ~150-250
  say(`\n=== OpenAI usage (measured calls + chars/4 estimate) ===`);
  say(`  total LLM calls: ${meta.totalLlmCalls}`);
  say(`  est input tokens:  ~${estInputTokens.toLocaleString()}`);
  say(`  est output tokens: ~${estOutputTokens.toLocaleString()}`);
  say(`  (blocked external requests: ${blockedRequests.length})`);
  say(`\nResults: ${resultsDir}`);
  say(`Verdict: ${summary.verdict}`);

  process.exit(0);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((err) => { realStdoutWrite(`FATAL: ${String(err?.stack || err)}\n`); process.exit(1); });
}
