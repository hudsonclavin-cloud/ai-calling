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
  const out = { count: 40, concurrency: 1, dryRun: false, only: null, callbackDiagnostic: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--callback-diagnostic') out.callbackDiagnostic = true;
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

// Extract the text Ava actually SPOKE from a TwiML response — either a <Say>
// body or the `text=` param of a /tts-live <Play> URL (TTS is disabled in the
// sim, so those are the only two forms). SSML tags are stripped. This is what a
// real caller hears, and what the simulated caller answers.
export function spokenFromTwiml(xml) {
  const s = String(xml || '');
  const say = s.match(/<Say[^>]*>([\s\S]*?)<\/Say>/);
  if (say) return stripSsml(xmlUnescape(say[1]));
  const play = s.match(/<Play>([^<]*)<\/Play>/);
  if (play) {
    const url = xmlUnescape(play[1]);
    const m = url.match(/[?&]text=([^&]+)/);
    if (m) { try { return stripSsml(decodeURIComponent(m[1])); } catch { return stripSsml(m[1]); } }
  }
  return '';
}
function stripSsml(t) { return String(t || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

// ── HTTP-ish helpers over app.inject ────────────────────────────────────────────
function form(obj) { return new URLSearchParams(obj).toString(); }
async function postForm(app, url, body, headers = {}) {
  const res = await app.inject({
    method: 'POST', url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
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
// Unique client IP per call so the production per-IP rate limiter (10/min) never
// throttles the batch — each simulated call presents a distinct caller IP.
export function clientIpFor(index) {
  return `10.9.${Math.floor(index / 254) % 254}.${(index % 254) + 1}`;
}
// Unique routing firmId per call so the production per-firm daily limiter
// (100/day) never throttles the batch. An unknown firmId resolves via
// loadFirmConfig's fallback to the seeded firm_default config, so conversation
// behavior is byte-identical to running under firm_default — this is a routing/
// rate-isolation measure only, not a config change.
export function firmIdFor(scenario) {
  return `sim_${scenario.id}`;
}

// Build the callback-representation matrix rows + grouped accuracy from records.
export function buildCallbackMatrix(records) {
  const norm = (x) => { const d = String(x || '').replace(/\D/g, ''); const t = d.length > 10 ? d.slice(-10) : d; return t.length === 10 ? '+1' + t : ''; };
  const rows = (records || []).map((r) => {
    const cb = (r.turns || []).filter((t) => t.classifiedKind === 'callback' || t.classifiedKind === 'phone_retry');
    let pendTrans = 0, usedTrans = 0, prevPend = false, prevUsed = false;
    for (const t of (r.turns || [])) { if (t.phoneRetryPending && !prevPend) pendTrans++; if (t.phoneRetryUsed && !prevUsed) usedTrans++; prevPend = !!t.phoneRetryPending; prevUsed = !!t.phoneRetryUsed; }
    const stored = r.collected?.callback_number || '';
    const expected = r.expected?.fields?.callback_number || '';
    return {
      scenarioId: r.scenarioId, representation: r.representation || '', group: r.group || '',
      raw: cb.map((t) => t.callerText).join(' || '), confidence: cb.map((t) => t.confidence).join('/'),
      expected, stored, normalizedStored: norm(stored),
      pass: !!norm(expected) && norm(stored) === norm(expected),
      pendTrans, usedTrans, turnCount: r.turnCount, repeatedCb: cb.length,
    };
  });
  const byRep = (ids) => { const rs = rows.filter((x) => ids.includes(x.representation)); const p = rs.filter((x) => x.pass).length; return { pass: p, total: rs.length, rate: rs.length ? p / rs.length : null }; };
  const groups = {
    digitForm: byRep(['digits-plain', 'digits-spaced', 'digits-hyphenated', 'digits-parentheses', 'e164']),
    punctuatedDigit: byRep(['digits-hyphenated', 'digits-parentheses']),
    e164: byRep(['e164']),
    wordForm: byRep(['words-zero', 'words-oh']),
    mixedForm: byRep(['mixed']),
    lowConfidenceRecovery: byRep(['low-confidence-digits']),
    digitCorrectionRecovery: byRep(['correction-digits']),
    wordCorrectionRecovery: byRep(['word-correction']),
    partialNumberRecovery: byRep(['partial-digits']),
  };
  return { rows, groups };
}

// Apply the dispatch decision rule to the grouped accuracy.
export function callbackVerdict(groups) {
  const rate = (g) => (g && g.rate !== null && g.rate !== undefined) ? g.rate : null;
  const digitRealistic = rate(groups.digitForm);
  const digitCorrection = rate(groups.digitCorrectionRecovery);
  const lowConf = rate(groups.lowConfidenceRecovery);
  const partial = rate(groups.partialNumberRecovery);
  const word = rate(groups.wordForm);
  const mixed = rate(groups.mixedForm);
  const wordCorrection = rate(groups.wordCorrectionRecovery);
  const allRealisticDigitPass = digitRealistic === 1 && digitCorrection === 1 && lowConf === 1 && partial === 1;
  const anyRealisticDigitFail = (digitRealistic !== null && digitRealistic < 1) || (digitCorrection !== null && digitCorrection < 1) || (lowConf !== null && lowConf < 1) || (partial !== null && partial < 1);
  const wordFails = word !== null && word < 1;
  const everythingPasses = allRealisticDigitPass && word === 1 && mixed === 1 && wordCorrection === 1;
  if (everythingPasses) return 'CALLBACK CONTROLLER PASS — ALL REPRESENTATIONS';
  if (allRealisticDigitPass && wordFails) return 'CALLBACK CONTROLLER PASS — WORD-FORM HARNESS ARTIFACT';
  if (anyRealisticDigitFail) return 'CALLBACK CONTROLLER DEFECT CONFIRMED';
  return 'MIXED RESULT — NEED RAW TWILIO STT CAPTURE';
}

// ── driving one call ────────────────────────────────────────────────────────────

async function driveCall({ app, db, scenario, callSid, fromPhone, firmId, clientIp }) {
  const { createSimulatedCaller } = await import('./simulated-caller.mjs');
  const caller = createSimulatedCaller(scenario);
  const turns = [];
  let status = 'unknown';
  let failureReason = '';
  let callerTurns = 0;

  const readSession = async () => (await db.loadSessions())[callSid] || null;
  const hdr = { 'x-forwarded-for': clientIp || '10.9.0.1' };

  // advance() posts a caller utterance to /twiml and follows any filler redirect
  // to /twiml-result, returning the final parsed reply + total wall-clock ms.
  const advance = async (speechResult, confidence) => {
    const t0 = Date.now();
    let r = await postForm(app, `/twiml?firmId=${encodeURIComponent(firmId)}`, {
      CallSid: callSid, From: fromPhone, SpeechResult: speechResult ?? '', Confidence: confidence ?? '',
    }, hdr);
    let parsed = parseTwiml(r.body);
    let hops = 0;
    while (parsed.kind === 'filler' && hops < 6) {
      r = await postForm(app, parsed.redirectPath, { CallSid: callSid }, hdr);
      parsed = parseTwiml(r.body);
      hops++;
    }
    return { parsed, ms: Date.now() - t0, body: r.body };
  };

  try {
    // Inbound webhook (no SpeechResult) -> Ava's opening.
    let { parsed, body } = await advance('', '');
    let spoken = spokenFromTwiml(body); // what Ava actually said (the caller answers THIS)
    let sess = await readSession();
    if (!sess) { return { status: 'infra-failure', failureReason: 'no session after inbound webhook', turns, transcript: [], finalSession: null }; }
    if (parsed.kind === 'done') { status = 'completed'; }

    while (parsed.kind !== 'done') {
      if (parsed.kind !== 'ava_turn') { status = 'malformed'; failureReason = `unexpected TwiML kind=${parsed.kind}`; break; }
      if (callerTurns >= MAX_CALLER_TURNS) { status = 'loop'; failureReason = 'reached max caller turns without completion'; break; }

      const trackedQuestionId = sess?.lastQuestionId || '';
      // Answer the SPOKEN question. Pass the spoken text as questionText so the
      // caller classifies from what it heard; keep trackedQuestionId only as a
      // fallback signal (it is often desynced from the spoken question).
      const r = caller.respond({ questionId: trackedQuestionId, questionText: spoken });
      callerTurns++;

      const adv = await advance(r.text, String(r.confidence));
      const after = await readSession();
      turns.push({
        index: callerTurns,
        questionId: trackedQuestionId,           // controller's tracked id (may be desynced)
        spokenQuestion: spoken,                   // what Ava actually said this turn
        trackedQuestionText: sess?.lastQuestionText || '',
        classifiedKind: r.kind,
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
      spoken = spokenFromTwiml(adv.body);
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
  const scenariosFile = args.callbackDiagnostic ? 'callback-scenarios.json' : 'scenarios.json';
  const scenariosDoc = JSON.parse(await fsp.readFile(path.join(__dirname, scenariosFile), 'utf8'));
  let scenarios = scenariosDoc.scenarios;
  const firmId = scenariosDoc.firmId || 'firm_default';

  if (args.callbackDiagnostic) {
    // run the whole matrix, in file order
  } else if (args.dryRun) {
    const dryIds = ['normal-intake-a', 'low-confidence-phone-a', 'distress-dv-a'];
    scenarios = scenarios.filter((s) => dryIds.includes(s.id));
  } else if (args.only) {
    scenarios = scenarios.filter((s) => args.only.includes(s.id));
  } else {
    scenarios = scenarios.slice(0, args.count);
  }

  const runId = new Date().toISOString().replace(/[:.]/g, '-')
    + (args.dryRun ? '-dry' : '') + (args.callbackDiagnostic ? '-callback-diagnostic' : '');
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
    const callFirmId = firmIdFor(scenario);
    const clientIp = clientIpFor(index);

    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    let result;
    try {
      if (scenario.prior_lead) await seedPriorLead(db, callFirmId, fromPhone, scenario.prior_lead);
      result = await driveCall({ app, db, scenario, callSid, fromPhone, firmId: callFirmId, clientIp });
    } catch (err) {
      // Per-call failure isolation: a throw becomes an infra-failure record so the run continues.
      result = { status: 'infra-failure', failureReason: `runOne exception: ${String(err?.message || err)}`, turns: [], transcript: [], finalSession: null, callerTurns: 0 };
    }
    const wallMs = Date.now() - t0;

    const traces = latencyTraces.filter((t) => t.callSid === callSid);
    const llmCount = llmIns.filter((l) => l.callSid === callSid).length;

    const collected = result.finalSession?.collected || {};
    const record = {
      runId, commit, model, scenarioId: scenario.id, family: scenario.family, variant: scenario.variant, routedFirmId: callFirmId,
      representation: scenario.representation || '', group: scenario.group || '',
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

  // Evaluator loaded up-front so finalization can always run, even if the loop throws.
  const evalMod = await import(pathToFileURL(path.join(__dirname, 'evaluate-results.mjs')).href);
  const records = [];
  const conc = Math.max(1, Math.min(2, args.concurrency));
  let summary = null;

  try {
    for (let i = 0; i < scenarios.length; i += conc) {
      const batch = scenarios.slice(i, i + conc);
      const done = await Promise.all(batch.map((s, j) => runOne(s, i + j)));
      records.push(...done);
    }
  } finally {
    // ALWAYS finalize the result package — even if a scenario or the loop threw.
    // Race-free stream close: end(cb) fires cb once the stream is fully flushed.
    await new Promise((res) => callsStream.end(res));
    await new Promise((res) => turnsStream.end(res));

    meta.finishedAt = new Date().toISOString();
    meta.blockedExternalRequests = blockedRequests;
    meta.totalLlmCalls = records.reduce((a, r) => a + (r?.llmCallCount || 0), 0);
    meta.avgSystemPromptChars = llmIns.length ? Math.round(llmIns.reduce((a, l) => a + (l.systemPromptChars || 0), 0) / llmIns.length) : 0;
    await fsp.writeFile(path.join(resultsDir, 'run-meta.json'), JSON.stringify(meta, null, 2)).catch((e) => say('run-meta write failed: ' + String(e)));

    try {
      summary = await evalMod.evaluateRun(resultsDir);
    } catch (e) {
      // Never let an evaluator error swallow the whole report package.
      say('evaluateRun failed: ' + String(e?.stack || e));
      const stub = { verdict: 'INCONCLUSIVE — HARNESS OR ENVIRONMENT FAILURE', evaluatorError: String(e?.message || e), runId, commit, model };
      await fsp.writeFile(path.join(resultsDir, 'summary.json'), JSON.stringify(stub, null, 2)).catch(() => {});
      await fsp.writeFile(path.join(resultsDir, 'report.md'), `# Ava simulation report\n\n**INCONCLUSIVE — evaluator failed:** ${String(e?.message || e)}\n`).catch(() => {});
      await fsp.writeFile(path.join(resultsDir, 'failures.md'), `# Failure analysis\n\nEvaluator failed before per-call analysis: ${String(e?.message || e)}\n`).catch(() => {});
    }
  }

  // OpenAI usage estimate (chars/4 heuristic).
  const estInputTokens = meta.totalLlmCalls * Math.ceil((meta.avgSystemPromptChars || 4000) / 4);
  const estOutputTokens = meta.totalLlmCalls * 180; // capped by max_output_tokens 500; typical ~150-250
  say(`\n=== OpenAI usage (measured calls + chars/4 estimate) ===`);
  say(`  total LLM calls: ${meta.totalLlmCalls}`);
  say(`  est input tokens:  ~${estInputTokens.toLocaleString()}`);
  say(`  est output tokens: ~${estOutputTokens.toLocaleString()}`);
  say(`  (blocked external requests: ${blockedRequests.length})`);
  say(`\nResults: ${resultsDir}`);
  say(`Verdict: ${summary ? summary.verdict : 'INCONCLUSIVE — see evaluator error above'}`);

  if (args.callbackDiagnostic) {
    const { rows, groups } = buildCallbackMatrix(records);
    const csv = ['scenario_id,representation,group,raw_speechresult,confidence,expected,stored,normalized_stored,pass,phone_retry_pending_transitions,phone_retry_used_transitions,turn_count,repeated_callback_questions'];
    for (const x of rows) csv.push([x.scenarioId, x.representation, x.group, csvCell(x.raw), csvCell(x.confidence), x.expected, x.stored, x.normalizedStored, x.pass, x.pendTrans, x.usedTrans, x.turnCount, x.repeatedCb].join(','));
    await fsp.writeFile(path.join(resultsDir, 'callback-matrix.csv'), csv.join('\n') + '\n');
    const verdict = callbackVerdict(groups);
    const g = (x) => x.rate === null ? 'n/a' : `${x.pass}/${x.total} (${(x.rate * 100).toFixed(0)}%)`;
    say('\n=== CALLBACK MATRIX ===');
    for (const x of rows) say(`  ${x.pass ? 'PASS' : 'FAIL'}  ${x.representation.padEnd(22)} stored=${x.normalizedStored || '(none)'} exp=${x.expected}`);
    say('\n=== GROUPED ACCURACY ===');
    say(`  digit-form (plain/spaced/hyphen/paren/e164): ${g(groups.digitForm)}`);
    say(`  punctuated-digit: ${g(groups.punctuatedDigit)} · e164: ${g(groups.e164)}`);
    say(`  word-form: ${g(groups.wordForm)} · mixed: ${g(groups.mixedForm)}`);
    say(`  low-confidence recovery (digit): ${g(groups.lowConfidenceRecovery)}`);
    say(`  correction recovery — digit: ${g(groups.digitCorrectionRecovery)} · word: ${g(groups.wordCorrectionRecovery)}`);
    say(`  partial-number recovery (digit): ${g(groups.partialNumberRecovery)}`);
    say(`\nCALLBACK VERDICT: ${verdict}`);
    await fsp.writeFile(path.join(resultsDir, 'callback-verdict.json'), JSON.stringify({ verdict, groups }, null, 2));
  }

  process.exit(0);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) {
  main().catch((err) => { realStdoutWrite(`FATAL: ${String(err?.stack || err)}\n`); process.exit(1); });
}
