// The LLM path has never been covered by a test: every other suite runs with no
// OPENAI_API_KEY, which exercises only the deterministic fallback. These tests
// stub the OpenAI Responses API (and ElevenLabs) so the real contract — prompt
// out, streamed JSON back, parsed, spoken, recorded — runs end to end.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// ── vendor stubs, installed BEFORE server.mjs is imported ────────────────────

/** Next canned model reply, as the structured object the schema requires. */
let nextLlmReply = null;
let lastRequestBody = null;

function sseStream(payloadObject) {
  const json = JSON.stringify(payloadObject);
  const events = [
    // Deliver the JSON in two deltas so the early-text extractor has to work for it.
    { type: 'response.output_text.delta', delta: json.slice(0, Math.floor(json.length / 2)) },
    { type: 'response.output_text.delta', delta: json.slice(Math.floor(json.length / 2)) },
    { type: 'response.output_text.done', text: json },
  ];
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('api.openai.com/v1/responses')) {
    lastRequestBody = JSON.parse(String(init?.body || '{}'));
    return sseStream(nextLlmReply);
  }
  if (u.includes('api.elevenlabs.io')) {
    // A few KB of bytes is enough: the code only checks length and writes to disk.
    return new Response(Buffer.alloc(2048, 1), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  }
  if (u.includes('api.twilio.com') || u.includes('api.resend.com')) {
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return realFetch(url, init);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ava-llm-'));
process.env.DATA_DIR = tmp;
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3000';
process.env.SKIP_TWILIO_SIGNATURE_VALIDATION = 'true';
process.env.OPENAI_API_KEY = 'test-key';
process.env.ELEVENLABS_API_KEY = 'test-key';
process.env.ELEVENLABS_VOICE_ID = 'test-voice';
process.env.RESEND_API_KEY = '';
process.env.TWILIO_ACCOUNT_SID = '';
process.env.TWILIO_AUTH_TOKEN = '';

const { app } = await import('../server.mjs');
const db = await import('../db.mjs');

// ── helpers ──────────────────────────────────────────────────────────────────

function reply(overrides = {}) {
  return {
    extracted: { full_name: '', callback_number: '', practice_area: '', case_summary: '', caller_type: null, calling_for: '' },
    next_question_id: 'full_name',
    next_question_text: "I'm sorry that happened. Can I start with your name?",
    done_reason: null,
    clarifying_note: null,
    ...overrides,
  };
}

function post(url, body) {
  return app.inject({
    method: 'POST',
    url,
    payload: new URLSearchParams(body).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
}

function xmlUnescape(s) {
  return String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Resolve what the caller hears. With TTS stubbed this is a cached /api/tts URL. */
function spokenFrom(xml) {
  const out = [];
  for (const m of xml.matchAll(/<Play>([\s\S]*?)<\/Play>/g)) {
    const u = new URL(xmlUnescape(m[1]), 'http://x');
    out.push(u.searchParams.get('fb') || u.searchParams.get('text') || '');
  }
  for (const m of xml.matchAll(/<Say[^>]*>([\s\S]*?)<\/Say>/g)) out.push(xmlUnescape(m[1]));
  return out.filter(Boolean).join(' ');
}

async function turn(callSid, speech, from = '+17045550444') {
  const body = { CallSid: callSid, From: from, To: '+17045559999' };
  if (speech != null) { body.SpeechResult = speech; body.Confidence = '0.95'; }
  let xml = (await post('/twiml?firmId=firm_default', body)).body;
  const redirect = xml.match(/<Redirect[^>]*>([\s\S]*?)<\/Redirect>/)?.[1]?.replace(/&amp;/g, '&');
  if (redirect && redirect.includes('/twiml-result')) {
    const u = new URL(redirect);
    xml = (await post(u.pathname + u.search, { CallSid: callSid, From: from })).body;
  }
  return xml;
}

// ── tests ────────────────────────────────────────────────────────────────────

test('the model reply is parsed and its words are the ones spoken', async () => {
  const callSid = 'CALLM_SPEAKS_0001';
  nextLlmReply = reply();
  await turn(callSid, null);

  nextLlmReply = reply({
    extracted: { full_name: '', callback_number: '', practice_area: 'Personal Injury', case_summary: 'Rear-ended on I-95 on Tuesday', caller_type: null, calling_for: '' },
    next_question_id: 'callback_number',
    next_question_text: "That sounds rough — what's the best number to reach you?",
  });
  const xml = await turn(callSid, 'I got rear-ended on I-95 on Tuesday');

  const said = spokenFrom(xml);
  assert.ok(said.includes("what's the best number to reach you?"), `model's words must be spoken, got: ${said}`);
  const session = await db.getSession(callSid);
  assert.equal(session.collected.case_summary, 'Rear-ended on I-95 on Tuesday', 'extracted fields are merged');
});

test('the question recorded as asked is the question that was spoken', async () => {
  const callSid = 'CALLM_INVARIANT_0001';
  nextLlmReply = reply();
  await turn(callSid, null);

  // The model comes back to the name a second time — a field that is still empty
  // but has already been asked once. This used to be rejected, leaving Ava
  // speaking the name question while the state machine recorded a different one,
  // so the caller's answer was then graded against the wrong field and discarded.
  nextLlmReply = reply({
    next_question_id: 'full_name',
    next_question_text: "Sorry, I didn't catch that — who am I speaking with?",
  });
  const xml = await turn(callSid, 'mumble mumble');

  const said = spokenFrom(xml);
  const session = await db.getSession(callSid);
  assert.ok(said.includes(session.lastQuestionText), `spoken text must contain the recorded question.\n  spoken:   ${said}\n  recorded: ${session.lastQuestionText}`);
  assert.equal(session.lastQuestionId, 'full_name', 'recorded id matches the field the spoken question asks about');

  // And because the recorded field is right, the answer is now accepted.
  nextLlmReply = reply({
    extracted: { full_name: 'Rosa Delgado', callback_number: '', practice_area: '', case_summary: '', caller_type: null, calling_for: '' },
    next_question_id: 'callback_number',
    next_question_text: 'Thanks Rosa. And the best number to reach you?',
  });
  await turn(callSid, 'Rosa Delgado');
  const after = await db.getSession(callSid);
  assert.equal(after.collected.full_name, 'Rosa Delgado');
});

test('the prompt carries the conversation so far and the caller last utterance', async () => {
  const callSid = 'CALLM_PROMPT_0001';
  nextLlmReply = reply();
  await turn(callSid, null);
  nextLlmReply = reply({ next_question_id: 'callback_number', next_question_text: 'And your number?' });
  await turn(callSid, 'my husband was arrested last night');

  const userMessage = lastRequestBody.input.find((m) => m.role === 'user');
  const payload = JSON.parse(userMessage.content[0].text);
  assert.equal(payload.previous_exchange.caller_said, 'my husband was arrested last night');
  assert.ok(payload.previous_exchange.ava_asked, 'the model is told what Ava just asked');
  assert.equal(lastRequestBody.text.format.type, 'json_schema', 'structured output is requested');
  assert.equal(lastRequestBody.text.format.strict, true);
});

test('conversation history sent to the model contains no SSML', async () => {
  const callSid = 'CALLM_HISTORY_0001';
  nextLlmReply = reply();
  await turn(callSid, null);
  nextLlmReply = reply({ next_question_id: 'callback_number', next_question_text: 'And — the best number for you?' });
  await turn(callSid, 'I was hurt at work');
  nextLlmReply = reply({ next_question_id: 'case_summary', next_question_text: 'What happened, roughly when?' });
  await turn(callSid, 'seven oh four, five five five, one two one two');

  const userMessage = lastRequestBody.input.find((m) => m.role === 'user');
  const payload = JSON.parse(userMessage.content[0].text);
  // Ava's own lines are replayed to the model as history. When speakText carried
  // SSML, the model was being shown "<speak>Got it.<break time='350ms'/> ..." as
  // an example of how it should talk.
  assert.ok(payload.conversation_so_far, 'history is included');
  assert.ok(!/<speak>|<break/.test(payload.conversation_so_far), `history must be plain text: ${payload.conversation_so_far}`);
});

test('a malformed model reply does not end the call', async () => {
  const callSid = 'CALLM_MALFORMED_0001';
  nextLlmReply = reply();
  await turn(callSid, null);

  // Truncated/blank text is what the empty-speakText incidents looked like.
  nextLlmReply = reply({ next_question_id: 'callback_number', next_question_text: '' });
  const xml = await turn(callSid, 'I need help with a car accident');

  assert.ok(!/<Hangup\/>/.test(xml), 'an unusable model reply must not hang up on the caller');
  assert.ok(spokenFrom(xml).length > 0, 'Ava still says something');
});
