import 'dotenv/config';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fetch = globalThis.fetch;
if (!fetch) throw new Error('Node 18+ is required (global fetch).');

const PORT = Number(process.env.PORT || 5050);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS || 2500);
const MAX_TTS_CHARS = Number(process.env.MAX_TTS_CHARS || 220);

const MAX_QUESTIONS = 8;
const MAX_REPROMPTS = 2;
const REQUIRED_FIELDS = ['full_name', 'callback_number', 'practice_area', 'case_summary'];
const CLOSING_TEXT = "Thanks — I’ve got what I need. The attorney will review this and call you back.";

const QUESTION_BANK = {
  full_name: 'To start, what is your full name?',
  callback_number: 'What is the best callback number for the attorney?',
  practice_area: 'What type of legal matter is this about?',
  case_summary: 'Please briefly describe what happened and what help you need.',
  final_clarify: 'Before I wrap up, is there one key detail you want the attorney to know?',
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const FIRMS_FILE = path.join(DATA_DIR, 'firms.json');
const CALLS_FILE = path.join(DATA_DIR, 'calls.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const AUDIO_DIR = path.join(DATA_DIR, 'tts_audio');

const app = Fastify({ logger: true });
await app.register(formbody);

function nowIso() {
  return new Date().toISOString();
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

const seedFirm = {
  id: 'firm_default',
  name: 'Redwood Legal Group',
  practiceAreas: ['Personal Injury', 'Family Law', 'Employment'],
  officeHours: 'Mon-Fri 8:00 AM - 6:00 PM',
  disclaimers: 'This intake call is informational only and does not create an attorney-client relationship. We do not provide legal advice on this line.',
  intakeRules: 'Collect caller contact details and a short case summary. Escalate emergency threats to 911 guidance.',
};

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(AUDIO_DIR, { recursive: true });

  const firms = await readJson(FIRMS_FILE, null);
  if (!Array.isArray(firms) || firms.length === 0) {
    await writeJsonAtomic(FIRMS_FILE, [seedFirm]);
  }

  const calls = await readJson(CALLS_FILE, null);
  if (!Array.isArray(calls)) await writeJsonAtomic(CALLS_FILE, []);

  const leads = await readJson(LEADS_FILE, null);
  if (!Array.isArray(leads)) await writeJsonAtomic(LEADS_FILE, []);

  const sessions = await readJson(SESSIONS_FILE, null);
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
    await writeJsonAtomic(SESSIONS_FILE, {});
  }
}

await ensureDataFiles();

async function loadFirms() {
  return readJson(FIRMS_FILE, [seedFirm]);
}

async function saveFirms(firms) {
  await writeJsonAtomic(FIRMS_FILE, firms);
}

async function loadCalls() {
  return readJson(CALLS_FILE, []);
}

async function saveCalls(calls) {
  await writeJsonAtomic(CALLS_FILE, calls);
}

async function loadLeads() {
  return readJson(LEADS_FILE, []);
}

async function saveLeads(leads) {
  await writeJsonAtomic(LEADS_FILE, leads);
}

async function loadSessions() {
  return readJson(SESSIONS_FILE, {});
}

async function saveSessions(sessions) {
  await writeJsonAtomic(SESSIONS_FILE, sessions);
}

function normalizePhone(raw) {
  const txt = String(raw || '').trim();
  const digits = txt.replace(/[^\d+]/g, '');
  const onlyDigits = digits.replace(/\D/g, '');
  if (onlyDigits.length === 10) return `+1${onlyDigits}`;
  if (onlyDigits.length === 11 && onlyDigits.startsWith('1')) return `+${onlyDigits}`;
  if (digits.startsWith('+') && onlyDigits.length >= 10) return digits;
  return txt || 'unknown';
}

function findFirm(firms, firmId) {
  if (firmId) {
    const matched = firms.find((f) => f.id === firmId);
    if (matched) return matched;
  }
  return firms[0] || seedFirm;
}

function sanitizeFirmPatch(existing, patch) {
  return {
    ...existing,
    id: existing.id,
    name: String(patch?.name ?? existing.name ?? '').trim() || existing.name,
    practiceAreas: Array.isArray(patch?.practiceAreas)
      ? patch.practiceAreas.map((x) => String(x).trim()).filter(Boolean)
      : existing.practiceAreas,
    officeHours: String(patch?.officeHours ?? existing.officeHours ?? ''),
    disclaimers: String(patch?.disclaimers ?? existing.disclaimers ?? ''),
    intakeRules: String(patch?.intakeRules ?? existing.intakeRules ?? ''),
  };
}

function createSession({ callSid, firmId, fromPhone }) {
  return {
    callSid,
    firmId,
    fromPhone,
    callId: `call_${sha1(`${callSid}|${firmId}`)}`,
    leadId: `lead_${sha1(`${firmId}|${fromPhone}`)}`,
    turnCount: 0,
    repromptCount: 0,
    askedQuestionIds: [],
    collected: {
      full_name: '',
      callback_number: fromPhone || '',
      practice_area: '',
      case_summary: '',
    },
    lastQuestionId: '',
    lastQuestionText: '',
    transcript: [],
    disclaimerShown: false,
    done: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function extractStructuredDeterministic(userText) {
  const text = String(userText || '').trim();
  if (!text) return {};

  const extracted = {};
  const phoneMatch = text.match(/(\+?\d[\d\s().-]{8,}\d)/);
  if (phoneMatch) extracted.callback_number = normalizePhone(phoneMatch[1]);

  const nameMatch = text.match(/(?:my name is|this is)\s+([A-Za-z.'\-\s]{2,})/i);
  if (nameMatch) extracted.full_name = nameMatch[1].trim();

  const lower = text.toLowerCase();
  if (lower.includes('injury') || lower.includes('accident')) extracted.practice_area = 'Personal Injury';
  else if (lower.includes('divorce') || lower.includes('custody') || lower.includes('family')) extracted.practice_area = 'Family Law';
  else if (lower.includes('employment') || lower.includes('termination') || lower.includes('harassment')) extracted.practice_area = 'Employment';

  if (text.length > 24 && !nameMatch && !phoneMatch) extracted.case_summary = text;
  return extracted;
}

function isLikelyName(value, sourceText) {
  const v = String(value || '').trim();
  if (!v) return false;
  if (!/(my name is|this is)/i.test(sourceText)) return false;
  if (!/^[A-Za-z.'\-\s]{2,}$/.test(v)) return false;
  const words = v.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (/\b(personal|injury|case|accident|rear-ended|matter|help)\b/i.test(v)) return false;
  return true;
}

function isLikelyPhone(value) {
  const normalized = normalizePhone(value);
  return normalized.startsWith('+') && normalized.replace(/\D/g, '').length >= 10;
}

function isLikelySummary(value) {
  const v = String(value || '').trim();
  return v.length >= 20;
}

function buildDeterministicQuestion(session, firm) {
  const missing = REQUIRED_FIELDS.filter((field) => !String(session.collected[field] || '').trim());
  const nextField = missing[0] || null;
  if (!nextField) return { done: true, nextField: null, nextQuestionId: null, nextQuestionText: '' };

  if (!session.askedQuestionIds.includes(nextField)) {
    let text = QUESTION_BANK[nextField];
    if (nextField === 'practice_area' && Array.isArray(firm.practiceAreas) && firm.practiceAreas.length) {
      text = `What type of legal matter is this? We handle: ${firm.practiceAreas.join(', ')}.`;
    }
    return { done: false, nextField, nextQuestionId: nextField, nextQuestionText: text };
  }

  if (!session.askedQuestionIds.includes('final_clarify')) {
    return {
      done: false,
      nextField,
      nextQuestionId: 'final_clarify',
      nextQuestionText: QUESTION_BANK.final_clarify,
    };
  }

  return { done: true, nextField: null, nextQuestionId: null, nextQuestionText: '' };
}

async function callOpenAiForNextStep({ firm, session, userText }) {
  if (!OPENAI_API_KEY) return null;

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      extracted: {
        type: 'object',
        additionalProperties: false,
        properties: {
          full_name: { type: 'string' },
          callback_number: { type: 'string' },
          practice_area: { type: 'string' },
          case_summary: { type: 'string' },
        },
      },
      next_question_id: { type: 'string' },
      next_question_text: { type: 'string' },
      done_reason: { type: 'string' },
    },
    required: ['extracted', 'next_question_id', 'next_question_text'],
  };

  const prompt = {
    firm,
    required_fields: REQUIRED_FIELDS,
    asked_question_ids: session.askedQuestionIds,
    current_collected: session.collected,
    user_text: userText,
    constraints: {
      never_repeat_same_question: true,
      never_legal_advice: true,
      max_questions: MAX_QUESTIONS,
      max_reprompts: MAX_REPROMPTS,
    },
  };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      max_output_tokens: 350,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: 'You are an intake controller. Return only strict JSON per schema. Never provide legal advice. Only choose the next question and extract structured fields.',
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: JSON.stringify(prompt) }],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'next_step_output',
          schema,
          strict: true,
        },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI error ${res.status}: ${errText}`);
  }

  const payload = await res.json();
  const raw = payload?.output_text || payload?.output?.[0]?.content?.[0]?.text || '';
  if (!raw) return null;
  return JSON.parse(raw);
}

function mergeExtracted(session, extracted, userText) {
  const updates = {};
  for (const key of REQUIRED_FIELDS) {
    const value = String(extracted?.[key] ?? '').trim();
    if (!value) continue;
    if (key === 'full_name' && !isLikelyName(value, userText)) continue;
    if (key === 'callback_number' && !isLikelyPhone(value)) continue;
    if (key === 'case_summary' && !isLikelySummary(value)) continue;
    if (!session.collected[key]) {
      session.collected[key] = value;
      updates[key] = value;
      continue;
    }
    if (session.collected[key] !== value) {
      session.collected[key] = value;
      updates[key] = value;
    }
  }
  if (!session.collected.callback_number && session.fromPhone) {
    session.collected.callback_number = session.fromPhone;
    updates.callback_number = session.fromPhone;
  }
  return updates;
}

function composeSpeakText({ firm, session, bodyText }) {
  const trimmed = String(bodyText || '').trim();
  if (!trimmed) return '';
  if (session.disclaimerShown) return trimmed;

  session.disclaimerShown = true;
  const intro = `Hi, this is Ava, the attorney's assistant.`;
  return `${intro} ${trimmed}`;
}

function xmlEscape(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function synthesizeToDisk(text) {
  const safeText = truncateForSpeech(text, MAX_TTS_CHARS);
  if (!safeText || !ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return null;

  const key = sha1(`${ELEVENLABS_VOICE_ID}|${ELEVENLABS_MODEL_ID}|${safeText}`);
  const filePath = path.join(AUDIO_DIR, `${key}.mp3`);
  const already = await fs.readFile(filePath).catch(() => null);
  if (already) return key;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(500, TTS_TIMEOUT_MS));
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        Accept: 'audio/mpeg',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: safeText,
        model_id: ELEVENLABS_MODEL_ID,
        voice_settings: {
          stability: Number(process.env.ELEVEN_STABILITY ?? 0.32),
          similarity_boost: Number(process.env.ELEVEN_SIMILARITY ?? 0.92),
          style: Number(process.env.ELEVEN_STYLE ?? 0.78),
          use_speaker_boost: String(process.env.ELEVEN_SPEAKER_BOOST ?? 'true').toLowerCase() === 'true',
        },
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!resp.ok) return null;
    const audio = Buffer.from(await resp.arrayBuffer());
    if (!audio.length) return null;
    await fs.writeFile(filePath, audio);
    return key;
  } catch {
    return null;
  }
}

function addQueryParam(url, key, value) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
}

function truncateForSpeech(input, maxChars) {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  const limit = Math.max(120, Number(maxChars) || 220);
  if (text.length <= limit) return text;

  const windowed = text.slice(0, limit);
  const punctuationIdx = Math.max(windowed.lastIndexOf('.'), windowed.lastIndexOf('?'), windowed.lastIndexOf('!'));
  const softBoundaryIdx = windowed.lastIndexOf(' ');
  let cut = -1;

  if (punctuationIdx >= Math.floor(limit * 0.55)) {
    cut = punctuationIdx + 1;
  } else if (softBoundaryIdx >= Math.floor(limit * 0.55)) {
    cut = softBoundaryIdx;
  } else {
    cut = limit;
  }

  return windowed.slice(0, cut).trim();
}

function gatherTwiml({ actionUrl, speakText, ttsKey, emptyCount = 0 }) {
  const speakerNode = ttsKey
    ? `<Play>${xmlEscape(`${PUBLIC_BASE_URL}/api/tts?key=${encodeURIComponent(ttsKey)}`)}</Play>`
    : `<Say>${xmlEscape(speakText)}</Say>`;
  const redirectUrl = addQueryParam(addQueryParam(actionUrl, 'empty', '1'), 'rc', Number(emptyCount) + 1);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${xmlEscape(actionUrl)}" method="POST" speechTimeout="auto" timeout="6" actionOnEmptyResult="false" bargeIn="true">
    ${speakerNode}
  </Gather>
  <Redirect method="POST">${xmlEscape(redirectUrl)}</Redirect>
</Response>`;
}

function doneTwiml({ speakText, ttsKey }) {
  const speakerNode = ttsKey
    ? `<Play>${xmlEscape(`${PUBLIC_BASE_URL}/api/tts?key=${encodeURIComponent(ttsKey)}`)}</Play>`
    : `<Say>${xmlEscape(speakText)}</Say>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${speakerNode}
  <Hangup/>
</Response>`;
}

function appendTranscript(session, role, text) {
  const t = String(text || '').trim();
  if (!t) return;
  session.transcript.push({ role, text: t, ts: nowIso() });
}

async function persistSessionArtifacts(session, { assistantText, callerText, done }) {
  const calls = await loadCalls();
  const leads = await loadLeads();

  let call = calls.find((c) => c.callSid === session.callSid);
  if (!call) {
    call = {
      id: session.callId,
      callSid: session.callSid,
      firmId: session.firmId,
      fromPhone: session.fromPhone,
      leadId: session.leadId,
      status: 'in_progress',
      startedAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      outcome: '',
      collected: {},
      transcript: [],
    };
    calls.unshift(call);
  }

  const leadIdx = leads.findIndex((l) => l.id === session.leadId);
  if (leadIdx === -1) {
    leads.unshift({
      id: session.leadId,
      firmId: session.firmId,
      fromPhone: session.fromPhone,
      full_name: session.collected.full_name || '',
      callback_number: session.collected.callback_number || session.fromPhone,
      practice_area: session.collected.practice_area || '',
      case_summary: session.collected.case_summary || '',
      status: done ? 'ready_for_review' : 'in_progress',
      lastCallSid: session.callSid,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      transcript: [],
      timeline: [{ ts: nowIso(), type: 'call_started', detail: `Call ${session.callSid} started` }],
    });
  }

  const lead = leads.find((l) => l.id === session.leadId);
  if (callerText) {
    call.transcript.push({ role: 'caller', text: callerText, ts: nowIso() });
    lead.transcript.push({ role: 'caller', text: callerText, ts: nowIso() });
  }
  if (assistantText) {
    call.transcript.push({ role: 'assistant', text: assistantText, ts: nowIso() });
    lead.transcript.push({ role: 'assistant', text: assistantText, ts: nowIso() });
  }

  call.collected = { ...session.collected };
  call.updatedAt = nowIso();
  if (done) {
    call.status = 'completed';
    call.endedAt = nowIso();
    call.outcome = 'intake_complete';
  }

  lead.full_name = session.collected.full_name || lead.full_name;
  lead.callback_number = session.collected.callback_number || lead.callback_number;
  lead.practice_area = session.collected.practice_area || lead.practice_area;
  lead.case_summary = session.collected.case_summary || lead.case_summary;
  lead.lastCallSid = session.callSid;
  lead.updatedAt = nowIso();
  lead.status = done ? 'ready_for_review' : 'in_progress';

  await saveCalls(calls.slice(0, 500));
  await saveLeads(leads.slice(0, 500));
}

async function runNextStepController({ firmId, callSid, fromPhone, userText }) {
  const firms = await loadFirms();
  const firm = findFirm(firms, firmId);
  const sessions = await loadSessions();

  const normalizedPhone = normalizePhone(fromPhone);
  let session = sessions[callSid];
  if (!session) {
    session = createSession({ callSid, firmId: firm.id, fromPhone: normalizedPhone });
  }
  session.firmId = firm.id;
  session.fromPhone = normalizedPhone;

  const callerText = String(userText || '').trim();
  if (callerText) appendTranscript(session, 'caller', callerText);

  const deterministicExtracted = extractStructuredDeterministic(callerText);
  let llm = null;
  if (callerText) {
    try {
      llm = await callOpenAiForNextStep({ firm, session, userText: callerText });
    } catch (err) {
      app.log.warn({ err: String(err), callSid }, 'OpenAI next-step failed; using deterministic fallback');
    }
  }

  const extracted = { ...deterministicExtracted, ...(llm?.extracted || {}) };
  const fieldUpdates = mergeExtracted(session, extracted, callerText);

  const reachedQuestionCap = session.turnCount >= MAX_QUESTIONS;
  const allCollected = REQUIRED_FIELDS.every((f) => String(session.collected[f] || '').trim());

  let nextDecision = buildDeterministicQuestion(session, firm);
  if (!allCollected && !reachedQuestionCap && llm) {
    const nextId = String(llm.next_question_id || '').trim();
    const nextText = String(llm.next_question_text || '').trim();
    const missing = REQUIRED_FIELDS.filter((field) => !String(session.collected[field] || '').trim());

    if (nextId && nextText && !session.askedQuestionIds.includes(nextId) && missing.length) {
      nextDecision = {
        done: false,
        nextField: missing[0],
        nextQuestionId: nextId,
        nextQuestionText: nextText,
      };
    }
  }

  const done = allCollected || reachedQuestionCap || nextDecision.done;
  let speakText = CLOSING_TEXT;
  let nextField = null;

  if (!done) {
    session.turnCount += 1;
    session.lastQuestionId = nextDecision.nextQuestionId;
    session.lastQuestionText = nextDecision.nextQuestionText;
    session.askedQuestionIds.push(nextDecision.nextQuestionId);
    nextField = nextDecision.nextField;
    speakText = composeSpeakText({ firm, session, bodyText: nextDecision.nextQuestionText });
  } else {
    session.done = true;
    session.lastQuestionId = '';
    session.lastQuestionText = '';
    speakText = CLOSING_TEXT;
  }

  appendTranscript(session, 'assistant', speakText);
  session.updatedAt = nowIso();
  sessions[callSid] = session;
  await saveSessions(sessions);

  await persistSessionArtifacts(session, { assistantText: speakText, callerText, done: session.done });

  return {
    firm,
    session,
    payload: {
      speakText,
      done: session.done,
      updates: {
        ...fieldUpdates,
        turnCount: session.turnCount,
        repromptCount: session.repromptCount,
      },
      nextField,
    },
  };
}

function applyRepromptText(session) {
  if (session.repromptCount >= MAX_REPROMPTS) {
    session.done = true;
    return CLOSING_TEXT;
  }
  const base = session.lastQuestionText || QUESTION_BANK.full_name;
  return `Sorry, I didn’t catch that. ${base}`;
}

app.get('/health', async () => ({ ok: true }));
app.get('/favicon.ico', async (_, reply) => reply.code(204).send());

app.get('/api/firms', async () => {
  const firms = await loadFirms();
  return { data: firms };
});

app.get('/api/firms/:id', async (req, reply) => {
  const firms = await loadFirms();
  const firm = firms.find((f) => f.id === req.params.id);
  if (!firm) return reply.code(404).send({ error: 'Firm not found' });
  return { data: firm };
});

app.post('/api/firms/:id', async (req, reply) => {
  const firms = await loadFirms();
  const idx = firms.findIndex((f) => f.id === req.params.id);
  if (idx === -1) return reply.code(404).send({ error: 'Firm not found' });

  firms[idx] = sanitizeFirmPatch(firms[idx], req.body || {});
  await saveFirms(firms);
  return { data: firms[idx] };
});

app.get('/api/calls', async () => {
  const calls = await loadCalls();
  calls.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { data: calls.slice(0, 100) };
});

app.get('/api/leads', async () => {
  const leads = await loadLeads();
  leads.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { data: leads };
});

app.get('/api/leads/:id', async (req, reply) => {
  const leads = await loadLeads();
  const lead = leads.find((x) => x.id === req.params.id);
  if (!lead) return reply.code(404).send({ error: 'Lead not found' });
  return { data: lead };
});

app.post('/api/next-step', async (req, reply) => {
  const firmId = String(req.body?.firmId || '').trim();
  const callSid = String(req.body?.callSid || '').trim();
  const fromPhone = String(req.body?.fromPhone || '').trim();
  const userText = String(req.body?.userText || '').trim();

  if (!callSid) return reply.code(400).send({ error: 'callSid is required' });

  try {
    const result = await runNextStepController({ firmId, callSid, fromPhone, userText });
    return result.payload;
  } catch (err) {
    app.log.error({ err: String(err), callSid }, '/api/next-step failed');
    return reply.code(500).send({ error: 'next-step failed' });
  }
});

app.get('/api/tts', async (req, reply) => {
  const key = String(req.query?.key || '').trim();
  const text = String(req.query?.text || '').trim();

  if (key) {
    const filePath = path.join(AUDIO_DIR, `${key}.mp3`);
    const audio = await fs.readFile(filePath).catch(() => null);
    if (!audio) return reply.code(404).send({ error: 'audio not found' });
    reply.header('Content-Type', 'audio/mpeg');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(audio);
  }

  if (!text) return reply.code(400).send({ error: 'text or key is required' });

  const generated = await synthesizeToDisk(text);
  if (!generated) return reply.code(502).send({ error: 'tts unavailable' });

  const audio = await fs.readFile(path.join(AUDIO_DIR, `${generated}.mp3`));
  reply.header('Content-Type', 'audio/mpeg');
  reply.header('Cache-Control', 'public, max-age=31536000, immutable');
  return reply.send(audio);
});

app.post('/twiml', async (req, reply) => {
  const callSid = String(req.body?.CallSid || '').trim();
  const fromPhone = normalizePhone(req.body?.From);
  const userText = String(req.body?.SpeechResult || '').trim();
  const firmId = String(req.body?.firmId || req.query?.firmId || '').trim();
  const isEmptyRedirect = String(req.query?.empty || '') === '1';

  if (!callSid) {
    reply.header('Content-Type', 'text/xml');
    return reply.send(doneTwiml({ speakText: 'Unable to continue this call right now.', ttsKey: null }));
  }

  try {
    const sessions = await loadSessions();
    let session = sessions[callSid];
    if (!session) {
      session = createSession({ callSid, firmId: firmId || seedFirm.id, fromPhone });
      sessions[callSid] = session;
      await saveSessions(sessions);
    }

    let speakText = '';
    let done = false;

    if (!userText) {
      if (!session.lastQuestionId) {
        const firstStep = await runNextStepController({ firmId, callSid, fromPhone, userText: '' });
        speakText = firstStep.payload.speakText;
        done = firstStep.payload.done;
      } else {
        if (isEmptyRedirect || !userText) {
          session.repromptCount += 1;
        }
        speakText = applyRepromptText(session);
        done = session.done;

        if (!done) {
          appendTranscript(session, 'assistant', speakText);
          session.updatedAt = nowIso();
          sessions[callSid] = session;
          await saveSessions(sessions);
          await persistSessionArtifacts(session, { assistantText: speakText, callerText: '', done: false });
        } else {
          appendTranscript(session, 'assistant', speakText);
          session.updatedAt = nowIso();
          sessions[callSid] = session;
          await saveSessions(sessions);
          await persistSessionArtifacts(session, { assistantText: speakText, callerText: '', done: true });
        }
      }
    } else {
      const step = await runNextStepController({ firmId, callSid, fromPhone, userText });
      speakText = step.payload.speakText;
      done = step.payload.done;
    }

    const ttsKey = await synthesizeToDisk(speakText);
    reply.header('Content-Type', 'text/xml');

    if (done) {
      return reply.send(doneTwiml({ speakText, ttsKey }));
    }

    return reply.send(
      gatherTwiml({
        actionUrl: `${PUBLIC_BASE_URL}/twiml${firmId ? `?firmId=${encodeURIComponent(firmId)}` : ''}`,
        speakText,
        ttsKey,
        emptyCount: session.repromptCount,
      })
    );
  } catch (err) {
    app.log.error({ err: String(err), callSid }, '/twiml failed');
    reply.header('Content-Type', 'text/xml');
    return reply.send(doneTwiml({ speakText: 'Sorry, there was a technical issue. Please call again.', ttsKey: null }));
  }
});

app.log.info(`BOOT PORT=${PORT} PUBLIC_BASE_URL=${PUBLIC_BASE_URL}`);

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`HTTP listening on http://127.0.0.1:${PORT}`);
} catch (err) {
  app.log.error({ err: String(err) }, 'Server failed to start');
  process.exit(1);
}
