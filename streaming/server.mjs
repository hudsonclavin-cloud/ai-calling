import 'dotenv/config';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initSchema,
  migrateFromJson,
  loadCalls,
  loadLeads,
  loadSessions,
  saveSessions,
  persistSessionArtifacts,
} from './db.mjs';

const fetch = globalThis.fetch;
if (!fetch) throw new Error('Node 18+ is required (global fetch).');

const PORT = Number(process.env.PORT || 5050);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5';
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS || 2500);
const MAX_TTS_CHARS = Number(process.env.MAX_TTS_CHARS || 180);

const REQUIRED_FIELDS_DEFAULT = ['full_name', 'callback_number', 'practice_area', 'case_summary'];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const FIRMS_DIR = path.join(DATA_DIR, 'firms');       // NEW: per-firm config files live here
const CALLS_FILE = path.join(DATA_DIR, 'calls.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const AUDIO_DIR = path.join(DATA_DIR, 'tts_audio');

// ── Default firm config (used as fallback if no file found) ──────────────────
// To add a new firm: copy firm_default.json → firm_yourname.json and edit it.
// That's it. No code changes needed.
const DEFAULT_FIRM_CONFIG = {
  id: 'firm_default',
  name: 'Redwood Legal Group',
  ava_name: 'Ava',
  tone: 'warm-professional',
  opening: "Hi, this is Ava with Redwood Legal Group. I'm going to ask you a few quick questions so the attorney can review your case before calling you back.",
  closing: "Perfect. I've got everything I need. An attorney will review this and reach out to you soon.",
  practice_areas: ['Personal Injury', 'Family Law', 'Employment'],
  required_fields: REQUIRED_FIELDS_DEFAULT,
  question_overrides: {
    full_name: "First — what's your name?",
    callback_number: "And the best number to reach you?",
    practice_area: "What type of legal matter is this about?",
    case_summary: "Briefly — what happened and what kind of help are you looking for?",
    final_clarify: "One last thing — anything else the attorney should know?",
  },
  acknowledgments: ['Got it.', 'Sure.', 'Of course.', 'Okay.', 'Perfect.', 'Thanks for that.', 'Understood.'],
  max_questions: 8,
  max_reprompts: 2,
  office_hours: 'Mon-Fri 8:00 AM - 6:00 PM',
  disclaimer: 'This call is informational only and does not create an attorney-client relationship.',
  intake_rules: 'Collect caller contact details and a short case summary. Escalate emergency threats to 911 guidance.',
};

const app = Fastify({ logger: true });
await app.register(formbody);

// ── Per-session ack index (avoids repeated acknowledgments) ──────────────────
const sessionAckIndex = new Map();

function getNextAck(callSid, firmConfig) {
  const acks = firmConfig.acknowledgments?.length ? firmConfig.acknowledgments : DEFAULT_FIRM_CONFIG.acknowledgments;
  const last = sessionAckIndex.get(callSid) ?? -1;
  const next = (last + 1) % acks.length;
  sessionAckIndex.set(callSid, next);
  return acks[next];
}

// Read the next ack without advancing the index (used for speculative TTS prefetch)
function peekNextAck(callSid, firmConfig) {
  const acks = firmConfig.acknowledgments?.length ? firmConfig.acknowledgments : DEFAULT_FIRM_CONFIG.acknowledgments;
  const last = sessionAckIndex.get(callSid) ?? -1;
  return acks[(last + 1) % acks.length];
}

// ── Utilities ────────────────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString(); }

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

// ── Firm config loading ───────────────────────────────────────────────────────
// Firms are now loaded from individual JSON files in streaming/data/firms/
// Each file is named {firm_id}.json  e.g. firm_default.json, firm_silva.json
// Falls back to DEFAULT_FIRM_CONFIG if file not found.

async function loadFirmConfig(firmId) {
  const id = String(firmId || 'firm_default').trim();
  const filePath = path.join(FIRMS_DIR, `${id}.json`);
  const raw = await readJson(filePath, null);
  if (!raw) {
    app.log.warn(`Firm config not found for "${id}", using default`);
    return { ...DEFAULT_FIRM_CONFIG };
  }
  // Merge with defaults so missing keys always have a safe value
  return {
    ...DEFAULT_FIRM_CONFIG,
    ...raw,
    question_overrides: { ...DEFAULT_FIRM_CONFIG.question_overrides, ...(raw.question_overrides || {}) },
    acknowledgments: raw.acknowledgments?.length ? raw.acknowledgments : DEFAULT_FIRM_CONFIG.acknowledgments,
    required_fields: raw.required_fields?.length ? raw.required_fields : REQUIRED_FIELDS_DEFAULT,
  };
}

async function listFirmConfigs() {
  try {
    const files = await fs.readdir(FIRMS_DIR);
    const configs = await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          const id = f.replace('.json', '');
          return loadFirmConfig(id);
        })
    );
    return configs;
  } catch {
    return [{ ...DEFAULT_FIRM_CONFIG }];
  }
}

async function saveFirmConfig(firmId, data) {
  await fs.mkdir(FIRMS_DIR, { recursive: true });
  const filePath = path.join(FIRMS_DIR, `${firmId}.json`);
  await writeJsonAtomic(filePath, data);
}

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(FIRMS_DIR, { recursive: true });
  await fs.mkdir(AUDIO_DIR, { recursive: true });

  // Seed default firm config if it doesn't exist yet
  const defaultPath = path.join(FIRMS_DIR, 'firm_default.json');
  const existing = await fs.readFile(defaultPath).catch(() => null);
  if (!existing) {
    await writeJsonAtomic(defaultPath, DEFAULT_FIRM_CONFIG);
    app.log.info('Seeded default firm config at streaming/data/firms/firm_default.json');
  }

  // Initialize SQLite schema and migrate any existing JSON data on first run
  initSchema();
  await migrateFromJson({
    callsFile:    CALLS_FILE,
    leadsFile:    LEADS_FILE,
    sessionsFile: SESSIONS_FILE,
    logger: (msg) => app.log.info(msg),
  });
}

await ensureDataFiles();

// ── Phone normalization ───────────────────────────────────────────────────────

function normalizePhone(raw) {
  const txt = String(raw || '').trim();
  const digits = txt.replace(/[^\d+]/g, '');
  const onlyDigits = digits.replace(/\D/g, '');
  if (onlyDigits.length === 10) return `+1${onlyDigits}`;
  if (onlyDigits.length === 11 && onlyDigits.startsWith('1')) return `+${onlyDigits}`;
  if (digits.startsWith('+') && onlyDigits.length >= 10) return digits;
  return txt || 'unknown';
}

// ── Session ───────────────────────────────────────────────────────────────────

function createSession({ callSid, firmId, fromPhone, firmConfig }) {
  const collected = {};
  for (const field of (firmConfig.required_fields || REQUIRED_FIELDS_DEFAULT)) {
    collected[field] = field === 'callback_number' ? (fromPhone || '') : '';
  }
  return {
    callSid,
    firmId,
    fromPhone,
    callId: `call_${sha1(`${callSid}|${firmId}`)}`,
    leadId: `lead_${sha1(`${firmId}|${fromPhone}`)}`,
    turnCount: 0,
    repromptCount: 0,
    askedQuestionIds: [],
    collected,
    lastQuestionId: '',
    lastQuestionText: '',
    transcript: [],
    disclaimerShown: false,
    done: false,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

// ── Deterministic extraction ──────────────────────────────────────────────────

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
  else if (lower.includes('immigration') || lower.includes('visa') || lower.includes('deportation')) extracted.practice_area = 'Immigration';
  else if (lower.includes('criminal') || lower.includes('arrested') || lower.includes('charged')) extracted.practice_area = 'Criminal Defense';

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
  return String(value || '').trim().length >= 20;
}

// ── Question building (uses firm config) ──────────────────────────────────────

function getQuestionText(questionId, firmConfig) {
  const overrides = firmConfig.question_overrides || {};
  const defaults = DEFAULT_FIRM_CONFIG.question_overrides;
  const base = overrides[questionId] || defaults[questionId] || '';
  // Inject practice areas for the practice_area question
  if (questionId === 'practice_area' && firmConfig.practice_areas?.length) {
    return `What type of legal matter is this? We handle ${firmConfig.practice_areas.join(', ')}.`;
  }
  return base;
}

function buildDeterministicQuestion(session, firmConfig) {
  const requiredFields = firmConfig.required_fields || REQUIRED_FIELDS_DEFAULT;
  const missing = requiredFields.filter((field) => !String(session.collected[field] || '').trim());
  const nextField = missing[0] || null;
  if (!nextField) return { done: true, nextField: null, nextQuestionId: null, nextQuestionText: '' };

  if (!session.askedQuestionIds.includes(nextField)) {
    return {
      done: false,
      nextField,
      nextQuestionId: nextField,
      nextQuestionText: getQuestionText(nextField, firmConfig),
    };
  }

  if (!session.askedQuestionIds.includes('final_clarify')) {
    return {
      done: false,
      nextField,
      nextQuestionId: 'final_clarify',
      nextQuestionText: getQuestionText('final_clarify', firmConfig),
    };
  }

  return { done: true, nextField: null, nextQuestionId: null, nextQuestionText: '' };
}

// ── OpenAI call (firm-aware prompt) ──────────────────────────────────────────

async function callOpenAiForNextStep({ firmConfig, session, userText }) {
  if (!OPENAI_API_KEY) return null;

  const requiredFields = firmConfig.required_fields || REQUIRED_FIELDS_DEFAULT;

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
    firm_name: firmConfig.name,
    ava_name: firmConfig.ava_name || 'Ava',
    tone: firmConfig.tone || 'warm-professional',
    practice_areas: firmConfig.practice_areas,
    intake_rules: firmConfig.intake_rules,
    required_fields: requiredFields,
    asked_question_ids: session.askedQuestionIds,
    current_collected: session.collected,
    user_text: userText,
    constraints: {
      never_repeat_same_question: true,
      never_legal_advice: true,
      max_questions: firmConfig.max_questions || 8,
      max_reprompts: firmConfig.max_reprompts || 2,
      tone: firmConfig.tone === 'friendly'
        ? 'Warm, casual, friendly. Short questions. Sound like a helpful person, not a form.'
        : 'Warm but professional. Brief and clear. Under 20 words per question.',
    },
  };

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      max_output_tokens: 300,
      input: [
        {
          role: 'system',
          content: [{
            type: 'input_text',
            text: `You are ${firmConfig.ava_name || 'Ava'}, the intake assistant for ${firmConfig.name}. Return only strict JSON per schema. Never provide legal advice. Keep next_question_text short and conversational — under 20 words.`,
          }],
        },
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(prompt) }] },
      ],
      text: { format: { type: 'json_schema', name: 'next_step_output', schema, strict: true } },
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

// ── Field merging ─────────────────────────────────────────────────────────────

function mergeExtracted(session, extracted, userText, firmConfig) {
  const requiredFields = firmConfig.required_fields || REQUIRED_FIELDS_DEFAULT;
  const updates = {};
  for (const key of requiredFields) {
    const value = String(extracted?.[key] ?? '').trim();
    if (!value) continue;
    if (key === 'full_name' && !isLikelyName(value, userText)) continue;
    if (key === 'callback_number' && !isLikelyPhone(value)) continue;
    if (key === 'case_summary' && !isLikelySummary(value)) continue;
    if (!session.collected[key] || session.collected[key] !== value) {
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

// ── Speech composition (firm-aware) ──────────────────────────────────────────

function composeSpeakText({ session, bodyText, callSid, firmConfig }) {
  const trimmed = String(bodyText || '').trim();
  if (!trimmed) return '';

  if (!session.disclaimerShown) {
    session.disclaimerShown = true;
    // Use firm's custom opening instead of hardcoded greeting
    const opening = firmConfig.opening || `Hi, this is ${firmConfig.ava_name || 'Ava'}, the attorney's assistant.`;
    // If the bodyText is already the opening (first turn), don't double up
    if (trimmed === opening) return opening;
    return opening;
  }

  const ack = getNextAck(callSid || session.callSid, firmConfig);
  return `${ack} ${trimmed}`;
}

// ── XML + TwiML ───────────────────────────────────────────────────────────────

function xmlEscape(s) {
  return String(s || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function gatherTwiml({ actionUrl, speakText, ttsKey, emptyCount = 0 }) {
  const speakerNode = ttsKey
    ? `<Play>${xmlEscape(`${PUBLIC_BASE_URL}/api/tts?key=${encodeURIComponent(ttsKey)}`)}</Play>`
    : `<Say>${xmlEscape(speakText)}</Say>`;
  const redirectUrl = addQueryParam(addQueryParam(actionUrl, 'empty', '1'), 'rc', Number(emptyCount) + 1);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${xmlEscape(actionUrl)}" method="POST" speechTimeout="1" timeout="5" actionOnEmptyResult="true" bargeIn="true">
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

// ── TTS ───────────────────────────────────────────────────────────────────────

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
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_API_KEY, Accept: 'audio/mpeg', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: safeText,
          model_id: ELEVENLABS_MODEL_ID,
          voice_settings: {
            stability: Number(process.env.ELEVEN_STABILITY ?? 0.42),
            similarity_boost: Number(process.env.ELEVEN_SIMILARITY ?? 0.85),
            style: Number(process.env.ELEVEN_STYLE ?? 0.25),
            use_speaker_boost: String(process.env.ELEVEN_SPEAKER_BOOST ?? 'true').toLowerCase() === 'true',
          },
        }),
        signal: controller.signal,
      }
    ).finally(() => clearTimeout(timeout));

    if (!resp.ok) return null;
    const audio = Buffer.from(await resp.arrayBuffer());
    if (!audio.length) return null;
    await fs.writeFile(filePath, audio);
    return key;
  } catch {
    return null;
  }
}

// Pre-warm TTS cache using each firm's custom phrases
async function prewarmTtsCache() {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    app.log.info('TTS prewarm skipped — missing ElevenLabs credentials');
    return;
  }

  const firms = await listFirmConfigs();
  const allPhrases = new Set();

  for (const firm of firms) {
    // Opening and closing are firm-specific
    if (firm.opening) allPhrases.add(firm.opening);
    if (firm.closing) allPhrases.add(firm.closing);
    // All question overrides
    for (const q of Object.values(firm.question_overrides || {})) {
      if (q) allPhrases.add(q);
    }
    // All acknowledgments
    for (const ack of (firm.acknowledgments || [])) {
      if (ack) allPhrases.add(ack);
    }
    // Reprompts
    allPhrases.add(`Sorry, I didn't catch that. ${firm.question_overrides?.full_name || "What's your name?"}`);
    allPhrases.add(`Could you say that again? ${firm.question_overrides?.full_name || "What's your name?"}`);
  }

  app.log.info(`Prewarming TTS cache for ${allPhrases.size} phrases across ${firms.length} firm(s)...`);
  const results = await Promise.allSettled([...allPhrases].map((p) => synthesizeToDisk(p)));
  const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value).length;
  app.log.info(`TTS prewarm complete: ${succeeded}/${allPhrases.size} phrases cached`);
}

function addQueryParam(url, key, value) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
}

function truncateForSpeech(input, maxChars) {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  const limit = Math.max(120, Number(maxChars) || 180);
  if (text.length <= limit) return text;
  const windowed = text.slice(0, limit);
  const pIdx = Math.max(windowed.lastIndexOf('.'), windowed.lastIndexOf('?'), windowed.lastIndexOf('!'));
  const sIdx = windowed.lastIndexOf(' ');
  const cut = pIdx >= Math.floor(limit * 0.55) ? pIdx + 1 : sIdx >= Math.floor(limit * 0.55) ? sIdx : limit;
  return windowed.slice(0, cut).trim();
}

function appendTranscript(session, role, text) {
  const t = String(text || '').trim();
  if (!t) return;
  session.transcript.push({ role, text: t, ts: nowIso() });
}

// ── Core controller ───────────────────────────────────────────────────────────

async function runNextStepController({ firmId, callSid, fromPhone, userText }) {
  // Load this firm's config from its JSON file
  const firmConfig = await loadFirmConfig(firmId || 'firm_default');
  const sessions = await loadSessions();

  const normalizedPhone = normalizePhone(fromPhone);
  let session = sessions[callSid];
  if (!session) {
    session = createSession({ callSid, firmId: firmConfig.id, fromPhone: normalizedPhone, firmConfig });
  }
  session.firmId = firmConfig.id;
  session.fromPhone = normalizedPhone;

  const callerText = String(userText || '').trim();
  if (callerText) appendTranscript(session, 'caller', callerText);

  const deterministicExtracted = extractStructuredDeterministic(callerText);

  // Fire OpenAI immediately (parallel with TTS prefetch below)
  let llmPromise = null;
  if (callerText && OPENAI_API_KEY) {
    llmPromise = callOpenAiForNextStep({ firmConfig, session, userText: callerText }).catch((err) => {
      app.log.warn({ err: String(err), callSid }, 'OpenAI failed; using deterministic fallback');
      return null;
    });
  }

  // Speculatively start TTS on the most likely next phrase while OpenAI is thinking.
  // buildDeterministicQuestion is sync with no side effects — safe to call early.
  const deterministicDecision = buildDeterministicQuestion(session, firmConfig);
  let speculativeText = '';
  let ttsPrefetch = null;
  if (!deterministicDecision.done && deterministicDecision.nextQuestionText) {
    speculativeText = session.disclaimerShown
      ? `${peekNextAck(callSid, firmConfig)} ${deterministicDecision.nextQuestionText}`
      : (firmConfig.opening || `Hi, this is ${firmConfig.ava_name || 'Ava'}, the attorney's assistant.`);
    ttsPrefetch = synthesizeToDisk(speculativeText).catch(() => null);
  }

  const llm = llmPromise ? await llmPromise : null;
  const extracted = { ...deterministicExtracted, ...(llm?.extracted || {}) };
  const fieldUpdates = mergeExtracted(session, extracted, callerText, firmConfig);

  const maxQ = firmConfig.max_questions || 8;
  const reachedQuestionCap = session.turnCount >= maxQ;
  const requiredFields = firmConfig.required_fields || REQUIRED_FIELDS_DEFAULT;
  const allCollected = requiredFields.every((f) => String(session.collected[f] || '').trim());

  // Reuse the deterministic decision already computed above; override with LLM if it gives better guidance
  let nextDecision = deterministicDecision;
  if (!allCollected && !reachedQuestionCap && llm) {
    const nextId = String(llm.next_question_id || '').trim();
    const nextText = String(llm.next_question_text || '').trim();
    const missing = requiredFields.filter((field) => !String(session.collected[field] || '').trim());
    if (nextId && nextText && !session.askedQuestionIds.includes(nextId) && missing.length) {
      nextDecision = { done: false, nextField: missing[0], nextQuestionId: nextId, nextQuestionText: nextText };
    }
  }

  const done = allCollected || reachedQuestionCap || nextDecision.done;
  let speakText = firmConfig.closing || DEFAULT_FIRM_CONFIG.closing;
  let nextField = null;

  if (!done) {
    session.turnCount += 1;
    session.lastQuestionId = nextDecision.nextQuestionId;
    session.lastQuestionText = nextDecision.nextQuestionText;
    session.askedQuestionIds.push(nextDecision.nextQuestionId);
    nextField = nextDecision.nextField;
    speakText = composeSpeakText({ session, bodyText: nextDecision.nextQuestionText, callSid, firmConfig });
  } else {
    session.done = true;
    session.lastQuestionId = '';
    session.lastQuestionText = '';
    speakText = firmConfig.closing || DEFAULT_FIRM_CONFIG.closing;
    sessionAckIndex.delete(callSid);
  }

  appendTranscript(session, 'assistant', speakText);
  session.updatedAt = nowIso();
  sessions[callSid] = session;

  // Resolve TTS: if the prefetch already covers the final text, just await it
  // (likely already done); otherwise let it cache quietly and start fresh.
  let ttsKey;
  if (speakText === speculativeText && ttsPrefetch) {
    ttsKey = await ttsPrefetch;
  } else {
    if (ttsPrefetch) ttsPrefetch.catch(() => {});  // cache quietly, don't block
    ttsKey = await synthesizeToDisk(speakText);
  }

  // Fire-and-forget — the TwiML response doesn't depend on write completion
  saveSessions(sessions).catch((err) => app.log.warn({ err: String(err), callSid }, 'saveSessions failed'));
  persistSessionArtifacts(session, { assistantText: speakText, callerText, done: session.done })
    .catch((err) => app.log.warn({ err: String(err), callSid }, 'persistArtifacts failed'));

  return {
    firmConfig,
    session,
    payload: {
      speakText,
      ttsKey,
      done: session.done,
      updates: { ...fieldUpdates, turnCount: session.turnCount, repromptCount: session.repromptCount },
      nextField,
    },
  };
}

function applyRepromptText(session, firmConfig) {
  const maxReprompts = firmConfig?.max_reprompts || 2;
  if (session.repromptCount >= maxReprompts) {
    session.done = true;
    return firmConfig?.closing || DEFAULT_FIRM_CONFIG.closing;
  }
  const base = session.lastQuestionText || getQuestionText('full_name', firmConfig || DEFAULT_FIRM_CONFIG);
  return session.repromptCount % 2 === 0
    ? `Sorry, I didn't catch that. ${base}`
    : `Could you say that again? ${base}`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', async () => ({ ok: true }));
app.get('/favicon.ico', async (_, reply) => reply.code(204).send());

// List all firms
app.get('/api/firms', async () => {
  const firms = await listFirmConfigs();
  return { data: firms };
});

// Get a single firm
app.get('/api/firms/:id', async (req, reply) => {
  const config = await loadFirmConfig(req.params.id);
  if (config.id !== req.params.id) return reply.code(404).send({ error: 'Firm not found' });
  return { data: config };
});

// Create or update a firm — POST body is the full config JSON
// To onboard a new client: POST /api/firms/firm_newclient with their config
app.post('/api/firms/:id', async (req, reply) => {
  const id = String(req.params.id || '').trim();
  if (!id) return reply.code(400).send({ error: 'firm id required' });

  const existing = await loadFirmConfig(id);
  const updated = {
    ...DEFAULT_FIRM_CONFIG,
    ...existing,
    ...req.body,
    id, // id is always the URL param, not overridable
    question_overrides: { ...DEFAULT_FIRM_CONFIG.question_overrides, ...(existing.question_overrides || {}), ...(req.body?.question_overrides || {}) },
  };
  await saveFirmConfig(id, updated);
  return { data: updated };
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
    const audio = await fs.readFile(path.join(AUDIO_DIR, `${key}.mp3`)).catch(() => null);
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
  const firmId = String(req.body?.firmId || req.query?.firmId || 'firm_default').trim();
  const isEmptyRedirect = String(req.query?.empty || '') === '1';

  if (!callSid) {
    reply.header('Content-Type', 'text/xml');
    return reply.send(doneTwiml({ speakText: 'Unable to continue this call right now.', ttsKey: null }));
  }

  try {
    const firmConfig = await loadFirmConfig(firmId);
    const sessions = await loadSessions();
    let session = sessions[callSid];
    if (!session) {
      session = createSession({ callSid, firmId, fromPhone, firmConfig });
      sessions[callSid] = session;
      await saveSessions(sessions);
    }

    let speakText = '';
    let done = false;
    let ttsKey = null;

    if (!userText) {
      if (!session.lastQuestionId) {
        // First turn — controller handles TTS prefetch internally
        const firstStep = await runNextStepController({ firmId, callSid, fromPhone, userText: '' });
        speakText = firstStep.payload.speakText;
        done = firstStep.payload.done;
        ttsKey = firstStep.payload.ttsKey;
      } else {
        // Reprompt — start TTS and fire-and-forget saves in parallel
        if (isEmptyRedirect || !userText) session.repromptCount += 1;
        speakText = applyRepromptText(session, firmConfig);
        done = session.done;
        appendTranscript(session, 'assistant', speakText);
        session.updatedAt = nowIso();
        sessions[callSid] = session;
        const ttsPromise = synthesizeToDisk(speakText);
        saveSessions(sessions).catch((err) => app.log.warn({ err: String(err), callSid }, 'saveSessions failed'));
        persistSessionArtifacts(session, { assistantText: speakText, callerText: '', done })
          .catch((err) => app.log.warn({ err: String(err), callSid }, 'persistArtifacts failed'));
        ttsKey = await ttsPromise;
      }
    } else {
      // Normal turn — controller handles TTS prefetch internally
      const step = await runNextStepController({ firmId, callSid, fromPhone, userText });
      speakText = step.payload.speakText;
      done = step.payload.done;
      ttsKey = step.payload.ttsKey;
    }

    reply.header('Content-Type', 'text/xml');

    if (done) return reply.send(doneTwiml({ speakText, ttsKey }));

    return reply.send(
      gatherTwiml({
        actionUrl: `${PUBLIC_BASE_URL}/twiml?firmId=${encodeURIComponent(firmId)}`,
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

// ── Boot ──────────────────────────────────────────────────────────────────────

app.log.info(`BOOT PORT=${PORT} PUBLIC_BASE_URL=${PUBLIC_BASE_URL}`);

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`HTTP listening on http://127.0.0.1:${PORT}`);
  prewarmTtsCache().catch((err) => app.log.warn({ err: String(err) }, 'TTS prewarm error'));
} catch (err) {
  app.log.error({ err: String(err) }, 'Server failed to start');
  process.exit(1);
}