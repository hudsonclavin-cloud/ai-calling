import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  parseTwiml, xmlUnescape, callSidFor, fromPhoneFor, isAllowedHost, isolateEnv, MAX_CALLER_TURNS,
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

test('external non-OpenAI services are disabled by the fetch guard', () => {
  assert.equal(isAllowedHost('api.openai.com'), true);
  for (const h of ['api.elevenlabs.io', 'api.resend.com', 'api.twilio.com', 'api.stripe.com', 'example.com']) {
    assert.equal(isAllowedHost(h), false, `${h} must be blocked`);
  }
});

test('isolateEnv uses a temporary DATA_DIR and zeroes external keys', async () => {
  const prev = { ...process.env };
  const { tmp } = await isolateEnv();
  assert.ok(tmp.startsWith(os.tmpdir()), 'DATA_DIR should be under the OS temp dir');
  assert.equal(process.env.DATA_DIR, tmp);
  assert.equal(process.env.SKIP_TWILIO_SIGNATURE_VALIDATION, 'true');
  for (const k of ['ELEVENLABS_API_KEY', 'RESEND_API_KEY', 'TWILIO_ACCOUNT_SID', 'STRIPE_SECRET_KEY', 'NOTIFICATION_EMAIL']) {
    assert.equal(process.env[k], '', `${k} must be emptied`);
  }
  // restore anything we care about
  process.env.DATA_DIR = prev.DATA_DIR || '';
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

test('evaluateRun writes valid summary.json / report.md / failures.md', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ava-eval-'));
  const good = {
    runId: 't', commit: 'abc', model: 'gpt-4o-mini', scenarioId: 'normal-intake-a', family: 'normal-intake', variant: 'a',
    status: 'completed', done: true, turnCount: 5, isUrgent: false, description: 'd',
    collected: { full_name: 'Jordan Lee', callback_number: '+17045550128', practice_area: 'Personal Injury', case_summary: 'rear ended tuesday' },
    processingLatencyMs: [1200, 1400], transcript: [], turns: [], llmCallCount: 3,
    expected: { completed: true, fields: { full_name: 'Jordan Lee', callback_number: '+17045550128', practice_area: 'Personal Injury' }, summary_must_include: ['rear', 'tuesday'] },
  };
  await fsp.writeFile(path.join(dir, 'calls.jsonl'), JSON.stringify(good) + '\n');
  await fsp.writeFile(path.join(dir, 'run-meta.json'), JSON.stringify({ runId: 't', commit: 'abc', model: 'gpt-4o-mini', totalLlmCalls: 3, externalDisabled: ['ELEVENLABS'] }));
  const summary = await evaluateRun(dir);
  assert.ok(summary.verdict);
  assert.ok(Array.isArray(summary.gates) && summary.gates.length >= 8);
  const parsed = JSON.parse(await fsp.readFile(path.join(dir, 'summary.json'), 'utf8'));
  assert.equal(parsed.metrics.totalCalls, 1);
  const report = await fsp.readFile(path.join(dir, 'report.md'), 'utf8');
  assert.match(report, /Executive summary/);
  await fsp.readFile(path.join(dir, 'failures.md'), 'utf8');
  await fsp.rm(dir, { recursive: true, force: true });
});
