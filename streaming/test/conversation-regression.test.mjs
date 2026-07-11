// This corpus freezes caller behaviors identified during the D1-D5 and
// postflight audits. It is the regression scoreboard for the upcoming
// IntakeWorkflow refactor. It intentionally avoids external APIs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.join(__dirname, 'fixtures', 'ava-regression-corpus.json');
const corpus = JSON.parse(await fs.readFile(corpusPath, 'utf8'));

const REQUIRED_ENV_KEYS = [
  'DATA_DIR',
  'PUBLIC_BASE_URL',
  'SKIP_TWILIO_SIGNATURE_VALIDATION',
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'RESEND_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_ID',
  'NOTIFICATION_EMAIL',
  'ADMIN_API_KEY',
  'TTS_BUDGET_MS',
  'TTS_TIMEOUT_MS'
];

const VENDOR_OFF_ENV = {
  PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
  SKIP_TWILIO_SIGNATURE_VALIDATION: 'true',
  OPENAI_API_KEY: '',
  ELEVENLABS_API_KEY: '',
  RESEND_API_KEY: '',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  TWILIO_FROM_NUMBER: '',
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: '',
  STRIPE_PRICE_ID: '',
  NOTIFICATION_EMAIL: '',
  ADMIN_API_KEY: '',
  TTS_BUDGET_MS: '100',
  TTS_TIMEOUT_MS: '100'
};

const DEFAULT_COLLECTED = {
  full_name: '',
  callback_number: '',
  practice_area: '',
  case_summary: '',
  calling_for: ''
};

function validateCorpusShape(data) {
  assert.equal(data.version, 1, 'corpus version must be 1');
  assert.equal(data.mode, 'controller-replay', 'corpus mode must be controller-replay');
  assert.ok(Array.isArray(data.scenarios), 'corpus.scenarios must be an array');
  assert.equal(data.scenarios.length, 36, 'corpus must contain exactly 36 scenarios');

  const ids = data.scenarios.map((scenario) => scenario.id);
  assert.equal(new Set(ids).size, ids.length, 'scenario IDs must be unique');

  for (const scenario of data.scenarios) {
    const prefix = `${scenario.id || '(missing id)'}:`;
    assert.match(scenario.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${prefix} id must be stable kebab-case`);
    assert.equal(typeof scenario.category, 'string', `${prefix} category is required`);
    assert.equal(typeof scenario.description, 'string', `${prefix} description is required`);
    assert.ok(scenario.description.trim(), `${prefix} description must not be blank`);
    assert.equal(typeof scenario.startingState, 'object', `${prefix} startingState is required`);
    assert.ok(Array.isArray(scenario.turns), `${prefix} turns must be an array`);
    assert.ok(scenario.turns.length > 0, `${prefix} must include at least one turn`);
    assert.equal(typeof scenario.expect, 'object', `${prefix} expect is required`);
    assert.equal(typeof scenario.expect.collected, 'object', `${prefix} expect.collected is required`);
    assert.ok(Array.isArray(scenario.expect.notCollected), `${prefix} expect.notCollected is required`);
    assert.equal(typeof scenario.expect.done, 'boolean', `${prefix} expect.done is required`);
    assert.ok(Array.isArray(scenario.prohibitedSpeechFragments), `${prefix} prohibitedSpeechFragments is required`);

    for (const [turnIndex, turn] of scenario.turns.entries()) {
      assert.equal(typeof turn.callerText, 'string', `${prefix} turn ${turnIndex + 1} callerText is required`);
      assert.ok(turn.callerText.trim(), `${prefix} turn ${turnIndex + 1} callerText must not be blank`);
      if ('speechConfidence' in turn && turn.speechConfidence != null) {
        assert.equal(typeof turn.speechConfidence, 'number', `${prefix} turn ${turnIndex + 1} speechConfidence must be numeric or null`);
        assert.ok(turn.speechConfidence >= 0 && turn.speechConfidence <= 1, `${prefix} turn ${turnIndex + 1} speechConfidence must be 0..1`);
      }
    }
  }
}

async function setupHarness() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ava-conversation-regression-'));
  const originalEnv = new Map(REQUIRED_ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.DATA_DIR = tmpDir;
  for (const [key, value] of Object.entries(VENDOR_OFF_ENV)) {
    process.env[key] = value;
  }

  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    fetchCalls.push(url);
    throw new Error(`Unexpected external fetch during conversation regression: ${url}`);
  };

  const [{ app }, db] = await Promise.all([
    import('../server.mjs'),
    import('../db.mjs')
  ]);
  await app.ready();

  return {
    app,
    db,
    tmpDir,
    fetchCalls,
    async cleanup() {
      await app.close();
      globalThis.fetch = originalFetch;
      for (const [key, value] of originalEnv.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  };
}

function makeSession(scenario, index) {
  const callSid = `CAREGRESSION${String(index + 1).padStart(4, '0')}`;
  const fromPhone = scenario.startingState.fromPhone || `+1555010${String(index + 1).padStart(4, '0')}`;
  const now = new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString();
  const starting = scenario.startingState;
  const lastQuestionId = starting.lastQuestionId || '';

  return {
    callSid,
    firmId: 'firm_default',
    fromPhone,
    phoneFromCallerId: fromPhone,
    callId: `test_call_${scenario.id}`,
    leadId: `test_lead_${scenario.id}`,
    turnCount: starting.turnCount ?? 0,
    repromptCount: starting.repromptCount ?? 0,
    callerType: starting.callerType ?? 'new',
    callerTypeReprompts: starting.callerTypeReprompts ?? 0,
    knownName: starting.knownName || '',
    carriedCallback: starting.carriedCallback || '',
    isUrgent: Boolean(starting.isUrgent),
    urgencySpoken: Boolean(starting.urgencySpoken),
    phoneRetryPending: Boolean(starting.phoneRetryPending),
    phoneRetryUsed: Boolean(starting.phoneRetryUsed),
    askedQuestionIds: [...(starting.askedQuestionIds || (lastQuestionId ? [lastQuestionId] : []))],
    collected: { ...DEFAULT_COLLECTED, ...(starting.collected || {}) },
    lastQuestionId,
    lastQuestionText: starting.lastQuestionText || (lastQuestionId ? `Test prompt for ${lastQuestionId}` : ''),
    lastSpeechConfidence: null,
    internalClarifyingNote: '',
    transcript: [],
    disclaimerShown: starting.disclaimerShown ?? true,
    done: Boolean(starting.done),
    notified: false,
    createdAt: now,
    updatedAt: now
  };
}

async function injectTurn({ app, scenario, session, turn, scenarioIndex, turnIndex }) {
  const form = new URLSearchParams({
    CallSid: session.callSid,
    From: session.fromPhone,
    SpeechResult: turn.callerText
  });
  if (turn.speechConfidence != null) {
    form.set('Confidence', String(turn.speechConfidence));
  }

  const response = await app.inject({
    method: 'POST',
    url: '/twiml?firmId=firm_default',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': `198.51.${scenarioIndex + 1}.${turnIndex + 1}`
    },
    payload: form.toString()
  });

  assert.equal(response.statusCode, 200, `${scenario.id}: /twiml returned ${response.statusCode}`);
  let twiml = response.body;
  const resultUrl = extractResultRedirect(twiml);
  if (resultUrl) {
    const resultResponse = await app.inject({
      method: 'POST',
      url: resultUrl,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': `198.51.${scenarioIndex + 1}.${turnIndex + 101}`
      },
      payload: new URLSearchParams({ CallSid: session.callSid }).toString()
    });
    assert.equal(resultResponse.statusCode, 200, `${scenario.id}: /twiml-result returned ${resultResponse.statusCode}`);
    twiml = `${twiml}\n${resultResponse.body}`;
  }

  return {
    twiml,
    speech: extractCallerFacingSpeech(twiml)
  };
}

function extractResultRedirect(twiml) {
  const redirects = [...twiml.matchAll(/<Redirect[^>]*>([\s\S]*?)<\/Redirect>/g)]
    .map((match) => decodeXml(match[1].trim()));
  const result = redirects.find((url) => url.includes('/twiml-result'));
  if (!result) return null;
  const parsed = new URL(result);
  return `${parsed.pathname}${parsed.search}`;
}

function extractCallerFacingSpeech(twiml) {
  const texts = [];

  for (const match of twiml.matchAll(/<Play>([\s\S]*?)<\/Play>/g)) {
    const rawUrl = decodeXml(match[1].trim());
    try {
      const url = new URL(rawUrl);
      if (url.pathname === '/tts-live' && url.searchParams.has('text')) {
        texts.push(url.searchParams.get('text'));
      }
    } catch {
      // Non-URL Play nodes are ignored; this harness disables cached vendor TTS.
    }
  }

  for (const match of twiml.matchAll(/<Say(?:\s[^>]*)?>([\s\S]*?)<\/Say>/g)) {
    texts.push(decodeXml(match[1]));
  }

  return normalizeSpeech(texts.join(' '));
}

function decodeXml(value) {
  return String(value || '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function normalizeSpeech(value) {
  return String(value || '')
    .replace(/<break\b[^>]*\/?>/gi, ' ')
    .replace(/<\/?speak>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function assertScenarioResult(scenario, state, speeches) {
  const expected = scenario.expect;
  assert.equal(state.done, expected.done, `${scenario.id}: done state`);

  for (const [field, value] of Object.entries(expected.collected)) {
    assert.equal(state.collected?.[field], value, `${scenario.id}: collected.${field}`);
  }

  for (const field of expected.notCollected) {
    assert.equal(String(state.collected?.[field] || '').trim(), '', `${scenario.id}: ${field} should remain missing`);
  }

  if (!expected.done && expected.nextQuestionId != null) {
    assert.equal(state.lastQuestionId, expected.nextQuestionId, `${scenario.id}: next question id`);
  }

  if (expected.retryState) {
    for (const [field, value] of Object.entries(expected.retryState)) {
      assert.equal(state[field], value, `${scenario.id}: ${field}`);
    }
  }

  if (expected.flags) {
    for (const [field, value] of Object.entries(expected.flags)) {
      assert.equal(state[field], value, `${scenario.id}: flag ${field}`);
    }
  }

  assertSpeechConstraints(scenario, speeches);
}

function assertSpeechConstraints(scenario, speeches) {
  const joinedSpeech = normalizeSpeech(speeches.join(' '));
  assert.ok(joinedSpeech, `${scenario.id}: caller-facing speech should be observable`);

  const prohibited = [
    ...scenario.prohibitedSpeechFragments,
    ...(scenario.expect.mustNotContainSpeech || [])
  ];
  for (const fragment of prohibited) {
    assert.ok(!joinedSpeech.includes(fragment), `${scenario.id}: speech contained prohibited fragment "${fragment}" in "${joinedSpeech}"`);
  }

  const mustNotStartWith = scenario.expect.mustNotStartWithSpeech || [];
  for (const speech of speeches.map(normalizeSpeech).filter(Boolean)) {
    for (const prefix of mustNotStartWith) {
      assert.ok(!startsWithStandalonePrefix(speech, prefix), `${scenario.id}: speech started with prohibited prefix "${prefix}" in "${speech}"`);
    }
  }

  if (scenario.expect.speechStartsWithAny) {
    const finalSpeech = normalizeSpeech(speeches.at(-1) || '');
    const allowed = scenario.expect.speechStartsWithAny;
    assert.ok(
      allowed.some((prefix) => finalSpeech.startsWith(prefix)),
      `${scenario.id}: speech "${finalSpeech}" did not start with any allowed prefix: ${allowed.join(', ')}`
    );
  }
}

function startsWithStandalonePrefix(speech, prefix) {
  const bare = String(prefix || '').replace(/[.!?]+$/, '').toLowerCase();
  const text = String(speech || '').trim().toLowerCase();
  if (!bare) return false;
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}(?:[\\s.!?,:;-]|$)`).test(text);
}

test('Ava 30-scenario conversation regression corpus', async (t) => {
  validateCorpusShape(corpus);
  const harness = await setupHarness();
  t.after(harness.cleanup);

  for (const [index, scenario] of corpus.scenarios.entries()) {
    await t.test(`${scenario.id} (${scenario.category})`, async () => {
      const session = makeSession(scenario, index);
      await harness.db.saveSessions({ [session.callSid]: session });

      const speeches = [];
      for (const [turnIndex, turn] of scenario.turns.entries()) {
        const result = await injectTurn({
          app: harness.app,
          scenario,
          session,
          turn,
          scenarioIndex: index,
          turnIndex
        });
        speeches.push(result.speech);
      }

      const sessions = await harness.db.loadSessions();
      const state = sessions[session.callSid];
      assert.ok(state, `${scenario.id}: session should exist after replay`);
      assertScenarioResult(scenario, state, speeches);
    });
  }

  assert.deepEqual(harness.fetchCalls, [], 'conversation regression must not make external fetch calls');
});

test('callback deterministic parser: representation matrix + 25x repeatability', async (t) => {
  const harness = await setupHarness();
  t.after(harness.cleanup);
  const { extractPhoneCandidate, detectPhoneCorrectionIntent } = await import('../server.mjs');

  const matrix = [
    ['7045550128', '+17045550128', 'digits_direct'],
    ['704-555-0128', '+17045550128', 'digits_direct'],
    ['(704) 555-0128', '+17045550128', 'digits_direct'],
    ['704 555 0128', '+17045550128', 'digits_direct'],
    ['+1 704 555 0128', '+17045550128', 'digits_direct'],
    ['1-704-555-0128', '+17045550128', 'digits_direct'],
    ['The number is 7045550128', '+17045550128', 'digits_direct'],
    ['You can reach me at (704) 555-0128', '+17045550128', 'digits_direct'],
    ['seven zero four five five five zero one two eight', '+17045550128', 'digits_spoken_words'],
    ['seven oh four five five five oh one two eight', '+17045550128', 'digits_spoken_words'],
    ['seven zero four, five five five, zero one two eight', '+17045550128', 'digits_spoken_words'],
    ['my number is seven zero four five five five zero one two eight', '+17045550128', 'digits_spoken_words'],
    ['704 five five five 0128', '+17045550128', 'digits_mixed'],
    ['seven zero four 555 zero one two eight', '+17045550128', 'digits_mixed'],
    ['704-555-zero one two eight', '+17045550128', 'digits_mixed'],
  ];
  for (const [input, expected, prov] of matrix) {
    const seen = new Set();
    for (let i = 0; i < 25; i++) {
      const r = extractPhoneCandidate(input);
      assert.ok(r, `no candidate for: ${input}`);
      assert.equal(r.normalized, expected, `normalize: ${input}`);
      assert.equal(r.provenance, prov, `provenance: ${input}`);
      seen.add(r.normalized);
    }
    assert.equal(seen.size, 1, `${input}: must be deterministic across 25 runs`);
  }
  // Ambiguous / partial must never be guessed (Invariant 3).
  for (const bad of ['704555', 'five five five', 'call me at 704', '', 'no number here']) {
    assert.equal(extractPhoneCandidate(bad), null, `must not guess: ${bad}`);
  }
  // Explicit correction intent (Invariant 4).
  for (const c of ['No, the number is 7045550128', "That's wrong — it's 7045550128", 'Actually, use 7045550128', 'The correct number is 7045550128', 'I said 7045550128']) {
    assert.equal(detectPhoneCorrectionIntent(c), true, `correction intent: ${c}`);
  }
  for (const nc of ['Dana Rowe', 'Personal injury', '7045550128', 'yes that works']) {
    assert.equal(detectPhoneCorrectionIntent(nc), false, `not a correction: ${nc}`);
  }
});
