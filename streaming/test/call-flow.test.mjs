// End-to-end call-flow regression tests.
//
// These drive the server the way Twilio does — POST /twiml, follow the
// <Redirect>, POST the next utterance to the <Gather action> — instead of
// calling the controller directly. Every test here corresponds to a defect that
// reached production and was not visible to the controller-level corpus:
// what Ava SAYS versus what she RECORDS, what happens across a whole call rather
// than one turn, and what happens when two calls overlap.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const VENDOR_OFF_ENV = {
  PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
  SKIP_TWILIO_SIGNATURE_VALIDATION: 'true',
  OPENAI_API_KEY: '',
  ELEVENLABS_API_KEY: '',
  RESEND_API_KEY: '',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  TTS_BUDGET_MS: '100',
  TTS_TIMEOUT_MS: '100',
};

let app;
let db;

test.before(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ava-callflow-'));
  process.env.DATA_DIR = tmp;
  for (const [k, v] of Object.entries(VENDOR_OFF_ENV)) process.env[k] = v;
  const mod = await import('../server.mjs');
  app = mod.app;
  db = await import('../db.mjs');
});

// ── helpers ──────────────────────────────────────────────────────────────────

function post(url, body) {
  return app.inject({
    method: 'POST',
    url,
    payload: new URLSearchParams(body).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
}

/** XML entity decode — TwiML attribute and element text is escaped on the way out. */
function xmlUnescape(s) {
  return String(s)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // last: an escaped & must not re-trigger the others
}

/** Everything the caller actually hears in one TwiML document, in order. */
function spokenText(xml) {
  const out = [];
  for (const m of xml.matchAll(/<Play>([\s\S]*?)<\/Play>/g)) {
    const url = xmlUnescape(m[1]);
    const text = new URL(url, 'http://x').searchParams.get('text');
    if (text) out.push(text);
  }
  for (const m of xml.matchAll(/<Say[^>]*>([\s\S]*?)<\/Say>/g)) {
    out.push(xmlUnescape(m[1]));
  }
  return out.join(' ');
}

const hasGather = (xml) => /<Gather/.test(xml);
const hasHangup = (xml) => /<Hangup\/>/.test(xml);

/** One caller turn, following the filler redirect the way Twilio would. */
async function turn(callSid, speech, { firmId = 'firm_default', from = '+17045550111' } = {}) {
  const body = { CallSid: callSid, From: from, To: '+17045559999' };
  if (speech != null) {
    body.SpeechResult = speech;
    body.Confidence = '0.95';
  }
  let res = await post(`/twiml?firmId=${firmId}`, body);
  let xml = res.body;
  const redirect = xml.match(/<Redirect[^>]*>([\s\S]*?)<\/Redirect>/)?.[1]?.replace(/&amp;/g, '&');
  if (redirect && redirect.includes('/twiml-result')) {
    const u = new URL(redirect);
    xml = (await post(u.pathname + u.search, { CallSid: callSid, From: from })).body;
  }
  return xml;
}

// ── tests ────────────────────────────────────────────────────────────────────

test('first turn speaks the question it records as asked', async () => {
  const callSid = 'CATEST_FIRSTTURN_0001';
  const xml = await turn(callSid, null);
  const said = spokenText(xml);
  const session = await db.getSession(callSid);

  assert.ok(session, 'session was created');
  assert.equal(session.lastQuestionId, 'full_name', 'first recorded question is the name');
  // The regression: Ava greeted the caller and silently recorded the name
  // question as asked, so she never asked for it and the askedQuestionIds guard
  // then blocked her from ever asking again.
  assert.ok(
    said.includes(session.lastQuestionText),
    `spoken text must contain the recorded question.\n  spoken:   ${said}\n  recorded: ${session.lastQuestionText}`,
  );
  assert.ok(hasGather(xml) && !hasHangup(xml), 'call stays open');
});

test('Ava speaks plain text — SSML never reaches the caller or the transcript', async () => {
  const callSid = 'CATEST_NOSSML_0001';
  await turn(callSid, null);
  const xml = await turn(callSid, 'I was in a car accident last week');

  const said = spokenText(xml);
  assert.ok(!/<speak>|<break|<\/speak>/.test(said), `spoken text must not contain SSML: ${said}`);

  const session = await db.getSession(callSid);
  const assistantLines = session.transcript.filter((t) => t.role === 'assistant').map((t) => t.text);
  assert.ok(assistantLines.length > 0, 'transcript has assistant turns');
  for (const line of assistantLines) {
    // SSML in the transcript is shown to the attorney, replayed to the model as
    // conversation history, and fed to the repeat detector.
    assert.ok(!/<speak>|<break/.test(line), `transcript line must not contain SSML: ${line}`);
  }
});

test('a name given while Ava is asking for a number is captured, not discarded', async () => {
  const callSid = 'CATEST_LATENAME_0001';
  await turn(callSid, null);
  await turn(callSid, 'I was in a car accident last week and I need a lawyer');
  await turn(callSid, 'Maria Gonzalez');

  const session = await db.getSession(callSid);
  assert.equal(session.collected.full_name, 'Maria Gonzalez');
});

test('a still-empty core field is re-asked instead of dropped for "anything else?"', async () => {
  const callSid = 'CATEST_REASK_0001';
  await turn(callSid, null);
  await turn(callSid, 'I was in a car accident last week and I need a lawyer');
  const xml = await turn(callSid, 'Maria Gonzalez'); // answers the name, not the number

  const session = await db.getSession(callSid);
  assert.equal(session.collected.callback_number, '', 'number still missing');
  assert.equal(session.lastQuestionId, 'callback_number', 'Ava comes back to the number');
  assert.ok(!/anything else/i.test(spokenText(xml)), 'must not fall through to the final catch-all');
});

test('two separated silences do not end the call', async () => {
  const callSid = 'CATEST_SILENCE_0001';
  await turn(callSid, null);
  await turn(callSid, 'My name is Dana Whitfield');

  // Silence #1 — caller is looking something up.
  let xml = await turn(callSid, '');
  assert.ok(!hasHangup(xml), 'first silence must not hang up');

  // Caller comes back and speaks: the silence streak is broken.
  await turn(callSid, 'seven zero four, five five five, zero one two three');

  // Silence #2, much later in the call.
  xml = await turn(callSid, '');
  const session = await db.getSession(callSid);
  assert.ok(!hasHangup(xml), 'a second, non-consecutive silence must not hang up');
  assert.equal(session?.done, false, 'call is still open');
});

test('consecutive silences still close the call', async () => {
  const callSid = 'CATEST_SILENCE_0002';
  await turn(callSid, null);
  await turn(callSid, '');
  const xml = await turn(callSid, '');
  assert.ok(hasHangup(xml), 'max_reprompts consecutive silences ends the call');
});

test('a silent call is filed as partial, not as a completed intake', async () => {
  const callSid = 'CATEST_POCKETDIAL_0001';
  const from = '+17045550999';
  await turn(callSid, null, { from });
  await turn(callSid, '', { from });
  await turn(callSid, '', { from });

  const session = await db.getSession(callSid);
  assert.equal(session.done, true, 'the call did end');
  // A pocket dial must not reach the attorney as "New lead — Unknown Caller"
  // with outcome intake_complete.
  const call = await db.getCallByCallSid(callSid);
  assert.ok(call, 'call row exists');
  assert.notEqual(call.outcome, 'intake_complete', 'silence is not a completed intake');
});

test('a long call is never rate limited mid-conversation', async () => {
  const callSid = 'CATEST_RATELIMIT_0001';
  await turn(callSid, null);
  // Well past the old per-IP budget of 10 requests/minute. Every turn arrives
  // from the same address because all Twilio webhooks do.
  for (let i = 0; i < 14; i++) {
    const xml = await turn(callSid, `still talking, turn number ${i}`);
    assert.ok(
      !/lot of calls|unusually busy/i.test(spokenText(xml)),
      `turn ${i} was rate limited mid-call`,
    );
  }
});

test('concurrent calls keep their own state', async () => {
  const a = 'CATEST_CONCURRENT_A';
  const b = 'CATEST_CONCURRENT_B';

  await Promise.all([
    turn(a, null, { from: '+17045550201' }),
    turn(b, null, { from: '+17045550202' }),
  ]);
  await Promise.all([
    turn(a, 'My name is Alice Alvarez', { from: '+17045550201' }),
    turn(b, 'My name is Boris Becker', { from: '+17045550202' }),
  ]);

  const [sa, sb] = await Promise.all([db.getSession(a), db.getSession(b)]);
  assert.equal(sa.collected.full_name, 'Alice Alvarez');
  assert.equal(sb.collected.full_name, 'Boris Becker');
  assert.notEqual(sa.leadId, sb.leadId);
});

test('saving one session neither resurrects nor rewrites another', async () => {
  const keep = 'CATEST_ROW_KEEP';
  const gone = 'CATEST_ROW_GONE';

  await db.saveSession(gone, { callSid: gone, turnCount: 1, collected: {} });
  await db.saveSession(keep, { callSid: keep, turnCount: 7, collected: { full_name: 'Real Caller' } });
  await db.deleteSession(gone);

  // Writing an unrelated session must not bring the deleted row back (the
  // whole-table write did exactly that) or revert this row.
  await db.saveSession('CATEST_ROW_OTHER', { callSid: 'CATEST_ROW_OTHER', turnCount: 0, collected: {} });

  assert.equal(await db.getSession(gone), null, 'deleted session stays deleted');
  const kept = await db.getSession(keep);
  assert.equal(kept.turnCount, 7);
  assert.equal(kept.collected.full_name, 'Real Caller');
});

test('a repeat caller gets a new lead instead of overwriting the old one', async () => {
  const from = '+17045550777';
  const first = 'CATEST_REPEAT_CALL_1';
  const second = 'CATEST_REPEAT_CALL_2';

  await turn(first, null, { from });
  await turn(first, 'My name is Priya Raman', { from });
  const s1 = await db.getSession(first);

  await turn(second, null, { from });
  await turn(second, 'My name is Priya Raman', { from });
  const s2 = await db.getSession(second);

  // Lead identity used to be sha1(firmId, caller phone), so the second call
  // rewrote the first call's lead row: its case summary was replaced, the two
  // transcripts were merged, and any triage status the attorney had set was lost.
  assert.notEqual(s1.leadId, s2.leadId, 'each call gets its own lead');
  const [lead1, lead2] = await Promise.all([db.getLeadById(s1.leadId), db.getLeadById(s2.leadId)]);
  assert.ok(lead1, 'the first call’s lead still exists');
  assert.ok(lead2, 'the second call has its own lead');
});
