import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  parseTwiml, xmlUnescape, callSidFor, fromPhoneFor, clientIpFor, firmIdFor,
  isAllowedHost, isolateEnv, MAX_CALLER_TURNS, BLANKED_ENV,
} from '../simulation/run-simulations.mjs';
import { createSimulatedCaller, phoneToSpoken, classifyQuestion } from '../simulation/simulated-caller.mjs';
import { evaluateCall, evaluateRun, prohibitedAckHits } from '../simulation/evaluate-results.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scenariosPath = path.join(__dirname, '..', 'simulation', 'scenarios.json');

async function loadScenarios() {
  return JSON.parse(await fsp.readFile(scenariosPath, 'utf8')).scenarios;
}

test('scenarios: exactly 40', async () => {
  const s = await loadScenarios();
  assert.equal(s.length, 40);
});

test('scenarios: 20 unique families, two variants each', async () => {
  const s = await loadScenarios();
  const byFamily = new Map();
  for (const sc of s) byFamily.set(sc.family, (byFamily.get(sc.family) || 0) + 1);
  assert.equal(byFamily.size, 20, 'expected 20 unique families');
  for (const [fam, n] of byFamily) assert.equal(n, 2, `family ${fam} should have exactly 2 variants`);
  const variants = new Set(s.map((sc) => sc.variant));
  assert.deepEqual([...variants].sort(), ['a', 'b']);
});

test('scenarios: unique ids', async () => {
  const s = await loadScenarios();
  const ids = s.map((sc) => sc.id);
  assert.equal(new Set(ids).size, ids.length, 'scenario ids must be unique');
});

test('all 40 scenarios satisfy the schema and initialize a caller (incl. distress-dv-a)', async () => {
  const s = await loadScenarios();
  for (const sc of s) {
    assert.ok(sc.id && sc.family && sc.variant, `${sc.id}: missing id/family/variant`);
    assert.ok(sc.facts && typeof sc.facts === 'object', `${sc.id}: facts must be an object`);
    assert.ok(Array.isArray(sc.events), `${sc.id}: events must be an array`);
    assert.ok(sc.expected && typeof sc.expected === 'object', `${sc.id}: expected must be an object`);
    const caller = createSimulatedCaller(sc); // must not throw
    const first = caller.respond({ questionId: '', questionText: 'what can I help you with?' });
    assert.ok(typeof first.text === 'string' && first.text.length > 0, `${sc.id}: empty first response`);
  }
  const distress = s.find((x) => x.id === 'distress-dv-a');
  assert.ok(distress && distress.expected.urgent === true, 'distress-dv-a must exist and expect urgent');
  const c = createSimulatedCaller(distress);
  assert.ok(c.respond({ questionId: 'full_name', questionText: 'your name?' }).text.length > 0);
});

test('clientIpFor + firmIdFor give each call an isolated rate-limit bucket', async () => {
  const s = await loadScenarios();
  const ips = s.map((_, i) => clientIpFor(i));
  assert.equal(new Set(ips).size, 40, 'client IPs must be unique per call (per-IP 10/min limiter)');
  for (const ip of ips) assert.match(ip, /^10\.9\.\d+\.\d+$/);
  const firms = s.map((sc) => firmIdFor(sc));
  assert.equal(new Set(firms).size, 40, 'routing firmIds must be unique per call (per-firm 100/day limiter)');
  for (const f of firms) assert.match(f, /^sim_/);
});

test('unique CallSids across all 40 for a fixed run', async () => {
  const s = await loadScenarios();
  const sids = s.map((sc) => callSidFor('fixed-run-id', sc.id));
  assert.equal(new Set(sids).size, 40);
  for (const sid of sids) assert.match(sid, /^CA[0-9a-f]{32}$/);
  const froms = s.map((_, i) => fromPhoneFor(i));
  assert.equal(new Set(froms).size, 40, 'from-phones must be unique per scenario index');
});

test('turn cap is 12', () => {
  assert.equal(MAX_CALLER_TURNS, 12);
});

test('fetch guard blocks every non-OpenAI host, including railway/prod URLs and datastores', () => {
  assert.equal(isAllowedHost('api.openai.com'), true);
  for (const h of [
    'api.elevenlabs.io', 'api.resend.com', 'api.twilio.com', 'api.stripe.com',
    'ai-calling-production-421b.up.railway.app', 'adorable-imagination-production-fb96.up.railway.app',
    'example.com', 'localhost:5432',
  ]) assert.equal(isAllowedHost(h), false, `${h} must be blocked`);
});

test('isolateEnv: temp DATA_DIR overrides /railway-data, deletes prod env, preserves OpenAI, localhost URLs', async () => {
  // Simulate Railway production injection.
  process.env.DATA_DIR = '/railway-data';
  process.env.OPENAI_API_KEY = 'sk-test-PRESERVE-do-not-print';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  for (const k of BLANKED_ENV) process.env[k] = 'INJECTED';
  process.env.PUBLIC_BASE_URL = 'https://ai-calling-production-421b.up.railway.app';
  process.env.NEXT_PUBLIC_API_BASE = 'https://ai-calling-production-421b.up.railway.app';
  process.env.WEB_BASE_URL = 'https://adorable-imagination-production-fb96.up.railway.app';
  process.env.TWILIO_WEBHOOK_BASE_URL = 'https://ai-calling-production-421b.up.railway.app/twiml?firmId=firm_default';

  const { tmp, hasOpenAI } = await isolateEnv();

  assert.ok(tmp.startsWith(os.tmpdir()), 'DATA_DIR under OS temp dir');
  assert.equal(process.env.DATA_DIR, tmp);
  assert.notEqual(process.env.DATA_DIR, '/railway-data');
  assert.equal(hasOpenAI, true);
  assert.equal(process.env.OPENAI_API_KEY, 'sk-test-PRESERVE-do-not-print', 'OpenAI key preserved');
  assert.equal(process.env.OPENAI_MODEL, 'gpt-4o-mini', 'OpenAI model preserved');
  for (const k of BLANKED_ENV) assert.equal(process.env[k], undefined, `${k} must be deleted`);
  for (const u of ['PUBLIC_BASE_URL', 'NEXT_PUBLIC_API_BASE', 'WEB_BASE_URL', 'TWILIO_WEBHOOK_BASE_URL']) {
    assert.match(process.env[u], /127\.0\.0\.1:3000/, `${u} must be localhost`);
    assert.doesNotMatch(process.env[u], /railway\.app/, `${u} must not point at railway`);
  }
  assert.equal(process.env.SKIP_TWILIO_SIGNATURE_VALIDATION, 'true');
  delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_MODEL;
});

test('results directory is gitignored', async () => {
  const gi = await fsp.readFile(path.join(__dirname, '..', '.gitignore'), 'utf8');
  assert.match(gi, /simulation\/results\//);
});

test('phoneToSpoken and classifyQuestion behave', () => {
  assert.equal(phoneToSpoken('+17045550128'), 'seven zero four, five five five, zero one two eight');
  assert.equal(classifyQuestion('callback_number', ''), 'callback');
  assert.equal(classifyQuestion('', "what's the best number to reach you?"), 'callback');
  assert.equal(classifyQuestion('full_name', ''), 'name');
});

test('simulated caller adapts to the requested field and applies events', async () => {
  const s = await loadScenarios();
  const scen = s.find((x) => x.id === 'low-confidence-phone-a');
  const caller = createSimulatedCaller(scen);
  const first = caller.respond({ questionId: 'case_summary', questionText: 'what can I help you with?' });
  assert.equal(first.source, 'opening');
  const p1 = caller.respond({ questionId: 'callback_number', questionText: 'best number?' });
  assert.match(p1.source, /event/);
  assert.ok(p1.confidence < 0.5, 'first callback attempt should be low confidence per the event');
  const p2 = caller.respond({ questionId: 'callback_number', questionText: 'best number?' });
  assert.ok(p2.confidence > 0.9, 'second callback attempt should be clean');
});

test('parseTwiml classifies gather / filler / done', () => {
  const gather = `<Response><Gather action="http://x/twiml?firmId=firm_default"><Say>hi</Say></Gather><Redirect>http://x/twiml?empty=1</Redirect></Response>`;
  assert.equal(parseTwiml(gather).kind, 'ava_turn');
  const filler = `<Response><Play>f</Play><Redirect>http://x/twiml-result?callSid=CA1&amp;firmId=firm_default</Redirect></Response>`;
  const pf = parseTwiml(filler);
  assert.equal(pf.kind, 'filler');
  assert.match(pf.redirectPath, /twiml-result/);
  const done = `<Response><Say>bye</Say><Hangup/></Response>`;
  assert.equal(parseTwiml(done).kind, 'done');
  assert.equal(xmlUnescape('a&amp;b'), 'a&b');
});

test('evaluator: a wrong phone number fails the call', () => {
  const rec = {
    scenarioId: 'x', family: 'normal-intake', status: 'completed', done: true, turnCount: 5, isUrgent: false,
    collected: { full_name: 'Jordan Lee', callback_number: '+17045559999', practice_area: 'Personal Injury', case_summary: 'rear ended tuesday' },
    processingLatencyMs: [1000], transcript: [], turns: [],
    expected: { completed: true, fields: { full_name: 'Jordan Lee', callback_number: '+17045550128', practice_area: 'Personal Injury' }, summary_must_include: ['rear', 'tuesday'] },
  };
  const ev = evaluateCall(rec);
  assert.equal(ev.pass, false);
  assert.equal(ev.checks.field_phone, false);
  assert.ok(ev.defects.some((d) => d.type === 'wrong phone number'));
});

test('evaluator: a loop fails the call', () => {
  const rec = { scenarioId: 'x', family: 'normal-intake', status: 'loop', done: false, turnCount: 12, isUrgent: false, collected: {}, processingLatencyMs: [], transcript: [], turns: [], expected: { completed: true, fields: {} } };
  const ev = evaluateCall(rec);
  assert.equal(ev.pass, false);
  assert.equal(ev.crashFree, false);
});

test('evaluator: prohibited acknowledgment in a distress call fails', () => {
  const rec = {
    scenarioId: 'x', family: 'distress-dv', status: 'completed', done: true, turnCount: 4, isUrgent: true,
    collected: { full_name: 'Maria Santos', callback_number: '+17045550166', practice_area: 'Family Law', case_summary: 'protective order not safe' },
    processingLatencyMs: [1000],
    transcript: [{ role: 'assistant', text: 'Perfect. What is your name?' }, { role: 'caller', text: 'Maria Santos' }],
    turns: [],
    expected: { completed: true, distress: true, urgent: true, fields: { full_name: 'Maria Santos', callback_number: '+17045550166', practice_area: 'Family Law' }, summary_must_include: ['protective order', 'safe'] },
  };
  const ev = evaluateCall(rec);
  assert.equal(ev.checks.no_prohibited_ack, false);
  assert.equal(ev.pass, false);
  assert.equal(prohibitedAckHits(rec.transcript).length, 1);
});

test('prohibitedAckHits does not flag contextual mid-sentence use', () => {
  const t = [{ role: 'assistant', text: "I'll make sure that's alright and someone reaches out." }];
  assert.equal(prohibitedAckHits(t).length, 0);
});

test('evaluator: a clean completed call passes', () => {
  const rec = {
    scenarioId: 'x', family: 'normal-intake', status: 'completed', done: true, turnCount: 5, isUrgent: false,
    collected: { full_name: 'Jordan Lee', callback_number: '+17045550128', practice_area: 'Personal Injury', case_summary: 'rear ended on tuesday' },
    processingLatencyMs: [1200], transcript: [{ role: 'assistant', text: 'Thanks, and your name?' }], turns: [],
    expected: { completed: true, fields: { full_name: 'Jordan Lee', callback_number: '+17045550128', practice_area: 'Personal Injury' }, summary_must_include: ['rear', 'tuesday'] },
  };
  const ev = evaluateCall(rec);
  assert.equal(ev.pass, true, JSON.stringify(ev.defects));
});

test('always-finalize: evaluateRun writes all six files for a mixed run (completed + infra-failure + conversation-failure)', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ava-eval-'));
  const good = {
    runId: 't', commit: 'abc', model: 'gpt-4o-mini', scenarioId: 'normal-intake-a', family: 'normal-intake', variant: 'a',
    status: 'completed', done: true, turnCount: 5, isUrgent: false, description: 'clean',
    collected: { full_name: 'Jordan Lee', callback_number: '+17045550128', practice_area: 'Personal Injury', case_summary: 'rear ended tuesday' },
    processingLatencyMs: [1200, 1400], transcript: [], turns: [], llmCallCount: 3,
    expected: { completed: true, fields: { full_name: 'Jordan Lee', callback_number: '+17045550128', practice_area: 'Personal Injury' }, summary_must_include: ['rear', 'tuesday'] },
  };
  const infra = {
    runId: 't', commit: 'abc', model: 'gpt-4o-mini', scenarioId: 'distress-dv-a', family: 'distress-dv', variant: 'a',
    status: 'infra-failure', done: false, turnCount: 0, isUrgent: false, failureReason: 'no session after inbound webhook', description: 'infra',
    collected: { full_name: '', callback_number: '', practice_area: '', case_summary: '' },
    processingLatencyMs: [], transcript: [], turns: [], llmCallCount: 0,
    expected: { completed: true, urgent: true, distress: true, fields: { full_name: 'Maria Santos', callback_number: '+17045550166', practice_area: 'Family Law' }, summary_must_include: ['protective order'] },
  };
  const convFail = {
    runId: 't', commit: 'abc', model: 'gpt-4o-mini', scenarioId: 'normal-intake-b', family: 'normal-intake', variant: 'b',
    status: 'completed', done: true, turnCount: 5, isUrgent: false, description: 'wrong phone',
    collected: { full_name: 'Priya Nair', callback_number: '+17045559999', practice_area: 'Employment', case_summary: 'fired after overtime' },
    processingLatencyMs: [1100], transcript: [], turns: [], llmCallCount: 4,
    expected: { completed: true, fields: { full_name: 'Priya Nair', callback_number: '+17045550143', practice_area: 'Employment' }, summary_must_include: ['overtime', 'fired'] },
  };
  await fsp.writeFile(path.join(dir, 'calls.jsonl'), [good, infra, convFail].map((r) => JSON.stringify(r)).join('\n') + '\n');
  await fsp.writeFile(path.join(dir, 'turns.csv'), 'run_id,scenario_id,turn_index\n'); // zero-turn failure still valid
  await fsp.writeFile(path.join(dir, 'run-meta.json'), JSON.stringify({ runId: 't', commit: 'abc', model: 'gpt-4o-mini', totalLlmCalls: 7, externalDisabled: ['ELEVENLABS'] }));

  const summary = await evaluateRun(dir);

  // all six files present
  for (const f of ['calls.jsonl', 'turns.csv', 'run-meta.json', 'summary.json', 'report.md', 'failures.md']) {
    await fsp.readFile(path.join(dir, f), 'utf8');
  }
  const parsed = JSON.parse(await fsp.readFile(path.join(dir, 'summary.json'), 'utf8'));
  assert.equal(parsed.metrics.totalCalls, 3);
  assert.equal(parsed.metrics.infraFailures, 1, 'summary must count the infra-failure');
  assert.ok(parsed.metrics.conversationFailures >= 1, 'summary must count the conversation failure');
  assert.ok(summary.failedScenarios.includes('distress-dv-a'));
  assert.ok(summary.failedScenarios.includes('normal-intake-b'));
  const failures = await fsp.readFile(path.join(dir, 'failures.md'), 'utf8');
  assert.match(failures, /distress-dv-a/);
  assert.match(failures, /normal-intake-b/);
  await fsp.rm(dir, { recursive: true, force: true });
});
