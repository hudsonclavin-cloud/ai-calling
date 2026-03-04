import 'dotenv/config';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import Stripe from 'stripe';
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
  patchLead,
  createWebhookLog,
  getWebhookLogs,
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

const RESEND_API_KEY    = process.env.RESEND_API_KEY    || '';
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID  || '';
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN   || '';
const TWILIO_FROM_NUMBER  = process.env.TWILIO_FROM_NUMBER  || '';

const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY     || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_ID       = process.env.STRIPE_PRICE_ID       || '';
const WEB_BASE_URL          = process.env.WEB_BASE_URL          || 'http://localhost:3000';
const ADMIN_API_KEY         = process.env.ADMIN_API_KEY         || '';

const REQUIRED_FIELDS_DEFAULT = ['full_name', 'callback_number', 'practice_area', 'case_summary'];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const FIRMS_DIR = path.join(DATA_DIR, 'firms');       // per-firm config JSON files
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
  notification_email: '',
  notification_phone: '',
};

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const app = Fastify({ logger: true });
await app.register(formbody);

// Capture raw body for Stripe webhook signature verification
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  req.rawBody = body;
  try { done(null, JSON.parse(body.toString())); }
  catch (err) { done(err); }
});

// ── Rate limiting ────────────────────────────────────────────────────────────
// Sliding window: track hit timestamps per key, evict entries older than windowMs

const rateLimitStore = new Map(); // key → timestamp[]

function checkRateLimit(key, maxHits, windowMs) {
  const now = Date.now();
  const cutoff = now - windowMs;
  const hits = (rateLimitStore.get(key) || []).filter((t) => t > cutoff);
  if (hits.length >= maxHits) return false; // exceeded
  hits.push(now);
  rateLimitStore.set(key, hits);
  return true; // allowed
}

// Purge stale entries every 5 minutes to prevent memory growth
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [key, hits] of rateLimitStore.entries()) {
    const fresh = hits.filter((t) => t > cutoff);
    if (!fresh.length) rateLimitStore.delete(key);
    else rateLimitStore.set(key, fresh);
  }
}, 5 * 60_000);

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
// Firm configs are individual JSON files in streaming/data/firms/.
// Each file is named {firm_id}.json — e.g. firm_default.json, firm_acme.json
// Falls back to DEFAULT_FIRM_CONFIG if the file is not found.

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
  await initSchema();
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
  // Always initialize all default fields; effectiveConfig controls which are required
  const collected = {};
  for (const field of REQUIRED_FIELDS_DEFAULT) {
    collected[field] = field === 'callback_number' ? (fromPhone || '') : '';
  }
  // Also initialize any firm-specific fields not in the default set
  for (const field of (firmConfig.required_fields || REQUIRED_FIELDS_DEFAULT)) {
    if (!(field in collected)) {
      collected[field] = field === 'callback_number' ? (fromPhone || '') : '';
    }
  }
  return {
    callSid,
    firmId,
    fromPhone,
    callId: `call_${sha1(`${callSid}|${firmId}`)}`,
    leadId: `lead_${sha1(`${firmId}|${fromPhone}`)}`,
    turnCount: 0,
    repromptCount: 0,
    callerType: null,          // null | 'new' | 'returning'
    callerTypeReprompts: 0,    // failed detection attempts before defaulting
    isUrgent: false,           // true when urgency keywords detected
    urgencySpoken: false,      // true after urgency acknowledgment has been spoken
    phoneRetryPending: false,  // true when caller gave digits but extraction failed
    phoneRetryUsed: false,     // ensures only one phone retry per session
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

// Short filler words that should never be treated as extractable content
const FILLER_WORDS = new Set([
  'ok', 'okay', 'yes', 'no', 'sure', 'go ahead', 'ready', 'hi', 'hello',
  'yeah', 'yep', 'yup', 'alright', 'sounds good', 'got it', 'uh huh',
]);

function extractStructuredDeterministic(userText) {
  const text = String(userText || '').trim();
  if (!text) return {};

  // Skip extraction entirely for short acknowledgments and filler phrases
  if (text.length < 10 || FILLER_WORDS.has(text.toLowerCase())) return {};

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

  const words = text.split(/\s+/).filter(Boolean);
  if (text.length >= 40 && words.length >= 4 && !nameMatch && !phoneMatch) extracted.case_summary = text;
  return extracted;
}

function detectCallerType(text) {
  const lower = String(text || '').toLowerCase();
  if (/\b(new|first[\s-]?time|never called|first call|new client)\b/.test(lower)) return 'new';
  if (/\b(existing|returning|current client|already (working|have a case)|i have a case)\b/.test(lower)) return 'returning';
  return null;
}

function detectUrgency(text) {
  const lower = String(text || '').toLowerCase();
  return /\b(arrested|in jail|emergency|evicted today|court tomorrow|restraining order|accident just happened|in the hospital|at the hospital|injured right now|going to jail|being evicted)\b/.test(lower);
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
  return v.length >= 40 && v.split(/\s+/).filter(Boolean).length >= 4;
}

// Aggressive extraction for rambling callers (>100 words).
// Differs from extractStructuredDeterministic in two ways:
//  1. Captures case_summary even when name/phone are also present
//  2. Lowers the case_summary word threshold to 15 words
function extractAllFieldsFromLongResponse(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= 100) return extractStructuredDeterministic(text);

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

  // Capture full text as case_summary regardless of name/phone presence
  if (words.length >= 15) extracted.case_summary = text;
  return extracted;
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

function getEffectiveConfig(session, firmConfig) {
  if (session.callerType !== 'returning') return firmConfig;
  return {
    ...firmConfig,
    required_fields: ['full_name', 'case_summary'],
    question_overrides: {
      ...firmConfig.question_overrides,
      case_summary: "Got it. And briefly, what's the reason for your call today?",
    },
    closing: "Perfect. I'll let the team know you called. Someone will be in touch shortly.",
  };
}

function buildDeterministicQuestion(session, firmConfig) {
  // Pre-intake gate: must determine caller type before normal questions
  if (session.callerType === null) {
    return {
      done: false,
      nextField: '__caller_type__',
      nextQuestionId: '__caller_type__',
      nextQuestionText: 'Are you a new or existing client?',
    };
  }

  // Phone retry gate: caller gave digits but extraction failed on the callback_number turn
  if (session.phoneRetryPending) {
    return {
      done: false,
      nextField: 'callback_number',
      nextQuestionId: '__phone_retry__',
      nextQuestionText: "I want to make sure I have your number right — could you repeat it slowly?",
    };
  }

  const requiredFields = firmConfig.required_fields || REQUIRED_FIELDS_DEFAULT;
  const missing = requiredFields.filter((field) => !String(session.collected[field] || '').trim());
  if (!missing.length) return { done: true, nextField: null, nextQuestionId: null, nextQuestionText: '' };

  // Scan all missing fields for the first one not yet asked, not just missing[0].
  // Checking only missing[0] would allow a filler response to exhaust the "unasked"
  // slot and jump to final_clarify, skipping intermediate required fields.
  const nextField = missing.find((f) => !session.askedQuestionIds.includes(f)) ?? missing[0];

  if (!session.askedQuestionIds.includes(nextField)) {
    return {
      done: false,
      nextField,
      nextQuestionId: nextField,
      nextQuestionText: getQuestionText(nextField, firmConfig),
    };
  }

  // Every missing required field has been asked at least once — one final chance
  if (!session.askedQuestionIds.includes('final_clarify')) {
    return {
      done: false,
      nextField: missing[0],
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
          caller_type: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['full_name', 'callback_number', 'practice_area', 'case_summary', 'caller_type'],
      },
      next_question_id: { type: 'string' },
      next_question_text: { type: 'string' },
      done_reason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      clarifying_note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['extracted', 'next_question_id', 'next_question_text', 'done_reason', 'clarifying_note'],
  };

  const wordCount = userText.split(/\s+/).filter(Boolean).length;
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
    is_rambling: wordCount > 150,
    word_count: wordCount,
    caller_is_urgent: session.isUrgent,
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
            text: `You are ${firmConfig.ava_name || 'Ava'}, the intake assistant for ${firmConfig.name}. Return only strict JSON per schema. Never provide legal advice. Follow these rules:
1. Keep next_question_text under 20 words and conversational.
2. CALLER TYPE: If the caller says they are new or returning, set caller_type to 'new' or 'returning'. Otherwise null.
3. RAMBLING (is_rambling=true): Extract ALL useful fields from the long response. Move directly to the first MISSING required field — never ask for information already given.
4. CLARIFYING NOTE: If the caller's answer was vague or ambiguous, set clarifying_note to a brief confirming phrase (max 20 words, e.g. "Just to confirm — you mentioned a car accident."). If the answer was clear, set clarifying_note to null.
5. URGENCY: caller_is_urgent is set by the server — you do not need to detect it, just ensure next_question_text stays warm and concise.`,
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
    const opening = firmConfig.opening || `Hi, this is ${firmConfig.ava_name || 'Ava'}, the attorney's assistant.`;
    // On first turn, append the caller type question so the caller knows what to say
    return session.callerType === null && trimmed ? `${opening} ${trimmed}` : opening;
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

function gatherTwiml({ actionUrl, speakText, ttsKey, emptyCount = 0, hints = '' }) {
  const speakerNode = ttsKey
    ? `<Play>${xmlEscape(`${PUBLIC_BASE_URL}/api/tts?key=${encodeURIComponent(ttsKey)}`)}</Play>`
    : `<Say>${xmlEscape(speakText)}</Say>`;
  const redirectUrl = addQueryParam(addQueryParam(actionUrl, 'empty', '1'), 'rc', Number(emptyCount) + 1);
  const hintsAttr = hints ? ` hints="${xmlEscape(hints)}"` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${xmlEscape(actionUrl)}" method="POST" speechTimeout="2" timeout="6" actionOnEmptyResult="true" bargeIn="true" enhanced="true" language="en-US" profanityFilter="false"${hintsAttr}>
    ${speakerNode}
  </Gather>
  <Redirect method="POST">${xmlEscape(redirectUrl)}</Redirect>
</Response>`;
}

function voicemailTwiml({ firmId, callSid, fromPhone, firmConfig }) {
  const msg = xmlEscape(
    `Hi, you've reached ${firmConfig?.name || 'our office'}. Please leave your name, phone number, and a brief message after the tone and we'll get back to you shortly.`
  );
  const actionUrl = `${PUBLIC_BASE_URL}/voicemail-recording?firmId=${encodeURIComponent(firmId)}&callSid=${encodeURIComponent(callSid)}&from=${encodeURIComponent(fromPhone)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${msg}</Say>
  <Record maxLength="60" transcribe="false" action="${xmlEscape(actionUrl)}" method="POST" playBeep="true"/>
  <Hangup/>
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

  const voiceSettingsKey = `${process.env.ELEVEN_STABILITY ?? '0.55'}|${process.env.ELEVEN_SIMILARITY ?? '0.85'}|${process.env.ELEVEN_STYLE ?? '0.15'}|${process.env.ELEVEN_SPEAKER_BOOST ?? 'true'}`;
  const key = sha1(`${ELEVENLABS_VOICE_ID}|${ELEVENLABS_MODEL_ID}|${voiceSettingsKey}|${safeText}`);
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
            stability: Number(process.env.ELEVEN_STABILITY ?? 0.55),
            similarity_boost: Number(process.env.ELEVEN_SIMILARITY ?? 0.85),
            style: Number(process.env.ELEVEN_STYLE ?? 0.15),
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

// ── Welcome email (sent once when a new firm is created via self-serve signup) ─

function buildWelcomeEmailHtml({ firm, webhookUrl, dashboardUrl }) {
  const name = firm.ava_name || 'Ava';
  const steps = [
    'Go to <a href="https://console.twilio.com" style="color:#0ea5e9">console.twilio.com</a> → Phone Numbers → Manage → Active Numbers',
    'Click your phone number',
    'Under <strong>Voice &amp; Fax</strong> → "A Call Comes In", choose <strong>Webhook</strong>',
    'Set method to <strong>HTTP POST</strong> and paste your webhook URL below',
    'Click <strong>Save Configuration</strong>',
  ];

  const stepsHtml = steps.map((s, i) => `
    <tr>
      <td style="padding:12px 0;vertical-align:top">
        <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#0ea5e9;color:#fff;font-size:12px;font-weight:700;flex-shrink:0">${i + 1}</span>
      </td>
      <td style="padding:12px 0 12px 12px;font-size:14px;color:#1e293b;line-height:1.6">${s}</td>
    </tr>`).join('');

  const body = `
    <p style="font-size:16px;color:#1e293b;margin:0 0 20px">Hi ${firm.contact_name || 'there'}, your AI intake assistant <strong>${name}</strong> is set up and ready. Complete the 5-step Twilio connection below and you'll start capturing leads immediately.</p>

    <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:16px 20px;margin-bottom:24px">
      <p style="margin:0 0 8px;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#0369a1">Your Webhook URL</p>
      <code style="font-size:13px;color:#0c4a6e;word-break:break-all;line-height:1.5">${webhookUrl}</code>
    </div>

    <h3 style="margin:0 0 12px;font-size:16px;color:#1e293b">Twilio Setup (5 steps)</h3>
    <table cellpadding="0" cellspacing="0" style="width:100%">${stepsHtml}</table>

    <div style="margin-top:28px;background:#f8fafc;border-radius:10px;padding:16px 20px">
      <p style="margin:0 0 4px;font-size:13px;color:#64748b">Once connected, ${name} will automatically answer calls, run through your intake questions, and send you a summary like this one.</p>
    </div>

    <p style="margin:28px 0 0"><a href="${dashboardUrl}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:13px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">Go to my Dashboard →</a></p>`;

  return emailShell({ headerColor: '#0ea5e9', headerLabel: 'Welcome to Ava', headerTitle: `${name} is ready — Twilio setup`, body, firmName: firm.name });
}

async function sendWelcomeEmail(firm) {
  const webhookUrl = `${PUBLIC_BASE_URL}/twiml?firmId=${firm.id}`;
  const dashboardUrl = `${WEB_BASE_URL}/dashboard?firmId=${firm.id}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [firm.notification_email],
      subject: `Your ${firm.ava_name || 'Ava'} AI assistant is ready — Twilio setup instructions`,
      html: buildWelcomeEmailHtml({ firm, webhookUrl, dashboardUrl }),
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Resend error ${res.status}: ${errText}`);
  }
}

// ── Notifications ─────────────────────────────────────────────────────────────
// Both functions are async and throw on failure so the caller can log the error.
// Use fireNotifications() to call them fire-and-forget after a call completes.

// ── Email HTML builder helpers ────────────────────────────────────────────────

function emailShell({ headerColor, headerLabel, headerTitle, body, firmName }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
  <tr><td style="background:${headerColor};padding:24px 28px">
    <p style="margin:0 0 4px;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.75)">${headerLabel}</p>
    <h1 style="margin:0;font-size:22px;font-weight:700;color:#fff">${headerTitle}</h1>
  </td></tr>
  <tr><td style="padding:28px">${body}</td></tr>
  <tr><td style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0">
    <p style="margin:0;font-size:12px;color:#94a3b8">Powered by <strong>Ava</strong> for ${firmName || 'your firm'}</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function badge(text, color) {
  const colors = { emerald: '#ecfdf5;color:#065f46', amber: '#fffbeb;color:#92400e', violet: '#f5f3ff;color:#5b21b6', sky: '#e0f2fe;color:#075985' };
  const style = colors[color] || '#f1f5f9;color:#334155';
  return `<span style="display:inline-block;background:#${style.split(';')[0].replace('#','')};color:${style.split(';')[1]?.replace('color:','')};padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600">${text}</span>`;
}

function infoRow(label, value) {
  return `<tr><td style="padding:8px 0;color:#64748b;font-size:14px;width:140px;vertical-align:top">${label}</td><td style="padding:8px 0;color:#1e293b;font-size:14px;font-weight:500">${value || '—'}</td></tr>`;
}

function ctaButton(text, url, color = '#6d28d9') {
  return `<p style="margin:24px 0 0"><a href="${url}" style="display:inline-block;background:${color};color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">${text} →</a></p>`;
}

async function sendEmailNotification(session, firmConfig) {
  if (!RESEND_API_KEY || !firmConfig.notification_email) return;

  const { full_name, callback_number, practice_area, case_summary } = session.collected;
  const name = full_name || 'Unknown Caller';
  const area = practice_area || 'General';
  const phone = callback_number || session.fromPhone;
  const dashUrl = `${WEB_BASE_URL}/leads/${session.leadId}`;

  const urgencyBanner = session.isUrgent
    ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:12px 16px;margin-bottom:20px;color:#991b1b;font-size:14px;font-weight:600">⚠️ Urgent — caller indicated an emergency situation</div>`
    : '';

  const body = `
    <h2 style="margin:0 0 4px;font-size:20px;font-weight:700;color:#1e293b">${name}</h2>
    <p style="margin:0 0 16px"><a href="tel:${phone}" style="color:#6d28d9;text-decoration:none;font-size:15px">${phone}</a></p>
    ${urgencyBanner}
    <div style="margin-bottom:20px">${badge(area, 'violet')} ${session.callerType ? badge(session.callerType === 'returning' ? 'Returning Client' : 'New Client', 'sky') : ''}</div>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #e2e8f0">
      ${infoRow('Practice Area', area)}
      ${infoRow('Callback Number', `<a href="tel:${phone}" style="color:#6d28d9">${phone}</a>`)}
    </table>
    ${case_summary ? `<div style="margin-top:20px"><p style="margin:0 0 8px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8">Case Summary</p><blockquote style="margin:0;padding:14px 16px;background:#f8f5ff;border-left:4px solid #7c3aed;border-radius:0 8px 8px 0;font-size:14px;color:#1e293b;line-height:1.6">${case_summary}</blockquote></div>` : ''}
    ${ctaButton('View Lead in Dashboard', dashUrl)}`;

  const html = emailShell({
    headerColor: '#6d28d9',
    headerLabel: `New Lead — ${firmConfig.name || 'Your Firm'}`,
    headerTitle: name,
    body,
    firmName: firmConfig.name,
  });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: [firmConfig.notification_email], subject: `New lead — ${name} (${area})`, html }),
  });
  if (!res.ok) { const e = await res.text().catch(() => ''); throw new Error(`Resend error ${res.status}: ${e}`); }
}

async function sendPartialEmailNotification(session, firmConfig) {
  if (!RESEND_API_KEY || !firmConfig.notification_email) return;
  const { full_name, callback_number, practice_area } = session.collected || {};
  const name = full_name || 'Unknown Caller';
  const phone = callback_number || session.fromPhone;
  const area = practice_area || 'General';
  const dashUrl = `${WEB_BASE_URL}/leads/${session.leadId}`;
  const capturedFields = Object.entries(session.collected || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none';

  const body = `
    <h2 style="margin:0 0 4px;font-size:20px;font-weight:700;color:#1e293b">${name}</h2>
    <p style="margin:0 0 16px"><a href="tel:${phone}" style="color:#b45309;text-decoration:none;font-size:15px">${phone}</a></p>
    <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:12px 16px;margin-bottom:20px;color:#92400e;font-size:14px">
      Caller hung up before intake was completed.
    </div>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #e2e8f0">
      ${infoRow('Practice Area', area)}
      ${infoRow('Phone', `<a href="tel:${phone}" style="color:#b45309">${phone}</a>`)}
      ${infoRow('Fields Captured', capturedFields)}
    </table>
    ${ctaButton('View in Dashboard', dashUrl, '#d97706')}`;

  const html = emailShell({ headerColor: '#d97706', headerLabel: 'Partial Intake', headerTitle: `Partial Lead — ${name}`, body, firmName: firmConfig.name });

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: [firmConfig.notification_email], subject: `[Partial] Lead from ${name} (${area})`, html }),
  });
  if (!res.ok) { const e = await res.text().catch(() => ''); throw new Error(`Resend error ${res.status}: ${e}`); }
}

async function sendVoicemailEmailNotification({ fromPhone, transcript, firmConfig, leadId }) {
  if (!RESEND_API_KEY || !firmConfig.notification_email) return;
  const dashUrl = `${WEB_BASE_URL}/leads/${leadId}`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: [firmConfig.notification_email],
      subject: `[Voicemail] from ${fromPhone}`,
      html: `<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1e293b">
        <div style="background:#7c3aed;color:white;border-radius:8px 8px 0 0;padding:20px 24px">
          <p style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:1px;opacity:0.8">Voicemail</p>
          <h2 style="margin:4px 0 0">New Voicemail</h2>
        </div>
        <div style="border:1px solid #e2e8f0;border-top:0;border-radius:0 0 8px 8px;padding:24px">
          <p><strong>From:</strong> <a href="tel:${fromPhone}">${fromPhone}</a></p>
          ${transcript ? `<h3 style="margin-top:16px">Transcription</h3><blockquote style="border-left:4px solid #7c3aed;margin:0;padding:12px 16px;background:#f8f5ff;color:#1e293b;font-style:italic;border-radius:0 6px 6px 0">${transcript}</blockquote>` : '<p style="color:#64748b">No transcription available.</p>'}
          <p style="margin-top:24px"><a href="${dashUrl}" style="display:inline-block;background:#7c3aed;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">View in Dashboard →</a></p>
          <p style="color:#94a3b8;font-size:12px;margin-top:24px">Powered by Ava</p>
        </div>
      </body></html>`,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Resend error ${res.status}: ${errText}`);
  }
}

async function sendSmsNotification(session, firmConfig) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) return;
  if (!firmConfig.notification_phone) return;

  // Normalize to E.164: 10 digits → +1XXXXXXXXXX, 11 digits starting with 1 → +1XXXXXXXXXX
  const rawPhone = String(firmConfig.notification_phone).replace(/\D/g, '');
  const toPhone = rawPhone.length === 10 ? `+1${rawPhone}`
    : rawPhone.length === 11 && rawPhone[0] === '1' ? `+${rawPhone}`
    : firmConfig.notification_phone;

  const { full_name, callback_number, practice_area, case_summary } = session.collected;
  const name = full_name || 'Unknown';
  const area = practice_area || 'General';
  const summary = String(case_summary || '').slice(0, 100);
  const body = `New Ava lead: ${name}, ${area}. Call: ${callback_number || session.fromPhone}. Summary: ${summary}`;

  const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To:   toPhone,
        From: TWILIO_FROM_NUMBER,
        Body: body,
      }).toString(),
    }
  );

  if (!res.ok) {
    const resBody = await res.text().catch(() => '');
    throw new Error(`Twilio SMS error ${res.status}: ${resBody}`);
  }
}

async function scoreCallQuality(session) {
  if (!OPENAI_API_KEY || !session.transcript?.length) return;
  try {
    const transcript = session.transcript.map((e) => `${e.role}: ${e.text}`).join('\n');
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are evaluating an AI phone intake call. Score it 1-10 on three dimensions and return strict JSON: { "naturalness": <int>, "completeness": <int>, "efficiency": <int>, "overall": <int>, "flags": [<string>] }. naturalness=how conversational it felt, completeness=how much info was collected, efficiency=how many turns it took relative to info gathered. flags=array of short observations (max 3, each under 10 words). Be concise.',
          },
          { role: 'user', content: `Transcript:\n${transcript.slice(0, 3000)}` },
        ],
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const score = JSON.parse(raw);
    await patchLead(session.leadId, { quality_score: JSON.stringify(score) });
    app.log.info({ leadId: session.leadId, score }, 'quality score saved');
  } catch (err) {
    app.log.warn({ err: String(err), leadId: session.leadId }, 'quality scoring failed');
  }
}

function fireNotifications(session, firmConfig) {
  if (!session.done) return;
  sendEmailNotification(session, firmConfig)
    .catch((err) => app.log.warn({ err: String(err), leadId: session.leadId }, 'email notification failed'));
  sendSmsNotification(session, firmConfig)
    .catch((err) => app.log.warn({ err: String(err), leadId: session.leadId }, 'sms notification failed'));
  // Build a minimal lead object for the webhook payload
  const lead = { id: session.leadId, firmId: session.firmId, fromPhone: session.fromPhone, status: 'ready_for_review', ...session.collected };
  fireWebhooks(lead, session.firmId, firmConfig);
  scoreCallQuality(session); // fire-and-forget
}

// ── Webhook delivery ──────────────────────────────────────────────────────────

async function deliverWebhook(event, lead, firmId, firmConfig) {
  const url = firmConfig?.webhook_url;
  if (!url) return;

  const logId = `wh_${sha1(`${firmId}|${event}|${lead.id}|${Date.now()}`)}`;
  const delays = [1000, 3000, 9000];
  let lastStatus = null;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, lead, firm_id: firmId, timestamp: new Date().toISOString() }),
        signal: AbortSignal.timeout(10_000),
      });
      lastStatus = res.status;
      await createWebhookLog({ id: logId, firmId, event, url, statusCode: res.status, attempts: attempt + 1 });
      if (res.ok) return;
    } catch (err) {
      app.log.warn({ err: String(err), firmId, event, attempt }, 'webhook delivery attempt failed');
    }
    if (attempt < delays.length) await new Promise((r) => setTimeout(r, delays[attempt]));
  }
  await createWebhookLog({ id: logId, firmId, event, url, statusCode: lastStatus, attempts: delays.length + 1 });
}

function fireWebhooks(lead, firmId, firmConfig) {
  const event = lead.status === 'partial' ? 'lead.partial'
    : lead.status === 'voicemail' ? 'lead.voicemail'
    : 'lead.created';
  deliverWebhook(event, lead, firmId, firmConfig)
    .catch((err) => app.log.warn({ err: String(err), firmId }, 'webhook delivery error'));
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

  const deterministicExtracted = extractAllFieldsFromLongResponse(callerText);

  // If callerType is already known from a prior turn, use effectiveConfig for the LLM
  // so it only suggests questions for the fields actually required in this caller's path.
  const llmConfig = getEffectiveConfig(session, firmConfig);

  // Fire OpenAI immediately (parallel with TTS prefetch below)
  let llmPromise = null;
  if (callerText && OPENAI_API_KEY) {
    llmPromise = callOpenAiForNextStep({ firmConfig: llmConfig, session, userText: callerText }).catch((err) => {
      app.log.warn({ err: String(err), callSid }, 'OpenAI failed; using deterministic fallback');
      return null;
    });
  }

  // Speculatively start TTS on the most likely next phrase while OpenAI is thinking.
  // buildDeterministicQuestion is read-only (no side effects) — safe to call early.
  // This result is used ONLY for the TTS prefetch; session state is NOT updated here.
  const speculativeDecision = buildDeterministicQuestion(session, firmConfig);
  let speculativeText = '';
  let ttsPrefetch = null;
  if (!speculativeDecision.done && speculativeDecision.nextQuestionText) {
    speculativeText = session.disclaimerShown
      ? `${peekNextAck(callSid, firmConfig)} ${speculativeDecision.nextQuestionText}`
      : (firmConfig.opening || `Hi, this is ${firmConfig.ava_name || 'Ava'}, the attorney's assistant.`);
    ttsPrefetch = synthesizeToDisk(speculativeText).catch(() => null);
  }

  const llm = llmPromise ? await llmPromise : null;
  // Merge: LLM values win, but only if non-empty — never let an LLM empty string
  // wipe out a good deterministic extraction (e.g. case_summary from long text).
  // Also, don't let a short LLM case_summary overwrite a good long deterministic one.
  const extracted = { ...deterministicExtracted };
  for (const [k, v] of Object.entries(llm?.extracted || {})) {
    if (v == null || String(v).trim() === '') continue;
    if (k === 'case_summary' && extracted[k] && !isLikelySummary(String(v).trim())) continue;
    extracted[k] = v;
  }
  const fieldUpdates = mergeExtracted(session, extracted, callerText, firmConfig);

  // ── Urgency detection ──────────────────────────────────────────────────────
  if (!session.isUrgent && callerText && detectUrgency(callerText)) {
    session.isUrgent = true;
  }

  // ── Caller type detection phase ────────────────────────────────────────────
  if (session.callerType === null && callerText) {
    const detected = detectCallerType(callerText)
      || (llm?.extracted?.caller_type && ['new', 'returning'].includes(llm.extracted.caller_type)
          ? llm.extracted.caller_type : null);
    if (detected) {
      session.callerType = detected;
    } else {
      session.callerTypeReprompts += 1;
      if (session.callerTypeReprompts > 1) {
        session.callerType = 'new'; // default after 1 failed reprompt
      }
    }
  }

  const effectiveConfig = getEffectiveConfig(session, firmConfig);

  // ── Phone retry logic ──────────────────────────────────────────────────────
  if (!session.phoneRetryUsed && callerText) {
    if (session.lastQuestionId === '__phone_retry__') {
      // Retry turn: mark consumed, then try harder digit-stripping extraction
      session.phoneRetryPending = false;
      session.phoneRetryUsed = true;
      if (!fieldUpdates.callback_number) {
        const digits = callerText.replace(/\D/g, '');
        if (digits.length >= 10) {
          const candidate = digits.length === 10 ? `+1${digits}`
            : digits.length === 11 && digits[0] === '1' ? `+${digits}` : null;
          if (candidate && isLikelyPhone(candidate)) {
            session.collected.callback_number = candidate;
          }
        }
      }
    } else if (session.lastQuestionId === 'callback_number') {
      // Normal phone turn: if caller gave digits but extraction failed, schedule a retry
      const digits = callerText.replace(/\D/g, '');
      if (digits.length >= 7 && !fieldUpdates.callback_number) {
        session.phoneRetryPending = true;
      }
    }
  }

  const maxQ = firmConfig.max_questions || 8;
  const reachedQuestionCap = session.turnCount >= maxQ;
  const requiredFields = effectiveConfig.required_fields || REQUIRED_FIELDS_DEFAULT;
  const allCollected = requiredFields.every((f) => String(session.collected[f] || '').trim());

  // Recompute after mergeExtracted so nextDecision reflects the updated collected fields.
  // The speculative decision above may be stale if extraction filled a previously missing field.
  let nextDecision = buildDeterministicQuestion(session, effectiveConfig);
  if (!allCollected && !reachedQuestionCap && llm) {
    const nextId = String(llm.next_question_id || '').trim();
    const nextText = String(llm.next_question_text || '').trim();
    const missing = requiredFields.filter((field) => !String(session.collected[field] || '').trim());
    if (nextId && nextText && !session.askedQuestionIds.includes(nextId) && missing.includes(nextId) && missing.length) {
      nextDecision = { done: false, nextField: missing[0], nextQuestionId: nextId, nextQuestionText: nextText };
    }
  }

  const done = allCollected || reachedQuestionCap || nextDecision.done;

  let speakText = effectiveConfig.closing || DEFAULT_FIRM_CONFIG.closing;
  let nextField = null;

  if (!done) {
    session.turnCount += 1;
    session.lastQuestionId = nextDecision.nextQuestionId;
    session.lastQuestionText = nextDecision.nextQuestionText;
    session.askedQuestionIds.push(nextDecision.nextQuestionId);
    nextField = nextDecision.nextField;

    // Apply optional clarifying note from LLM (capped at 20 words)
    let questionBody = nextDecision.nextQuestionText;
    const clarifyNote = String(llm?.clarifying_note || '').trim();
    if (clarifyNote) {
      const capped = clarifyNote.split(/\s+/).filter(Boolean).slice(0, 20).join(' ');
      questionBody = `${capped} ${questionBody}`;
    }

    speakText = composeSpeakText({ session, bodyText: questionBody, callSid, firmConfig: effectiveConfig });

    // Urgency: replace normal ack with empathetic acknowledgment on first urgent turn
    if (session.isUrgent && !session.urgencySpoken) {
      session.urgencySpoken = true;
      speakText = `That sounds really stressful — I want to make sure we get someone to help you quickly. ${nextDecision.nextQuestionText}`;
    }
  } else {
    session.done = true;
    session.lastQuestionId = '';
    session.lastQuestionText = '';
    speakText = effectiveConfig.closing || DEFAULT_FIRM_CONFIG.closing;
    // Urgency on the final turn: prefix the closing so the caller still hears acknowledgment
    if (session.isUrgent && !session.urgencySpoken) {
      session.urgencySpoken = true;
      speakText = `That sounds really stressful — I want to make sure we get someone to help you quickly. ${speakText}`;
    }
    sessionAckIndex.delete(callSid);
  }

  // Log any time the speculative TTS phrase differed from what was actually spoken,
  // so we can see question-skip or phrasing-change patterns in the logs.
  if (ttsPrefetch && speakText !== speculativeText) {
    app.log.info(
      { callSid, speculativeText, speakText },
      'tts-prefetch miss — speculative phrase differed from final (prefetch cached for future use)',
    );
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
  fireNotifications(session, firmConfig);

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

app.get('/health', async () => {
  const [leads, sessions] = await Promise.all([loadLeads(), loadSessions()]);
  return {
    status: 'ok',
    uptime: process.uptime(),
    activeSessions: Object.keys(sessions).length,
    totalLeads: leads.length,
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  };
});
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
  const isNew = existing.id !== id;
  const updated = {
    ...DEFAULT_FIRM_CONFIG,
    ...existing,
    ...req.body,
    id, // id is always the URL param, not overridable
    question_overrides: { ...DEFAULT_FIRM_CONFIG.question_overrides, ...(existing.question_overrides || {}), ...(req.body?.question_overrides || {}) },
  };
  await saveFirmConfig(id, updated);
  if (isNew && updated.notification_email && RESEND_API_KEY) {
    sendWelcomeEmail(updated).catch((err) =>
      app.log.warn({ err: String(err) }, 'welcome email failed')
    );
  }
  return { data: updated };
});

app.get('/api/calls', async (req) => {
  const firmId = String(req.query?.firmId || '').trim();
  let calls = await loadCalls();
  if (firmId) calls = calls.filter((c) => c.firmId === firmId);
  calls.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { data: calls.slice(0, 100) };
});

app.get('/api/leads', async (req) => {
  const firmId = String(req.query?.firmId || '').trim();
  let leads = await loadLeads();
  if (firmId) leads = leads.filter((l) => l.firmId === firmId);
  leads.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { data: leads };
});

app.get('/api/leads/:id', async (req, reply) => {
  const firmId = String(req.query?.firmId || '').trim();
  const leads = await loadLeads();
  const lead = leads.find((x) => x.id === req.params.id);
  if (!lead) return reply.code(404).send({ error: 'Lead not found' });
  if (firmId && lead.firmId !== firmId) return reply.code(404).send({ error: 'Lead not found' });
  return { data: lead };
});

app.patch('/api/leads/:id', async (req, reply) => {
  const { id } = req.params;
  const allowed = ['status', 'contacted_at'];
  const updates = Object.fromEntries(
    Object.entries(req.body || {}).filter(([k]) => allowed.includes(k))
  );
  if (!Object.keys(updates).length) return reply.code(400).send({ error: 'No valid fields to update' });
  await patchLead(id, updates);
  return { ok: true };
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

app.get('/api/voice-preview', async (req, reply) => {
  const firmId = String(req.query?.firmId || 'firm_default').trim();
  const firmConfig = await loadFirmConfig(firmId);
  const aName = firmConfig.ava_name || 'Ava';
  const firmName = firmConfig.name || 'your firm';
  const text = String(req.query?.text || `Hi, thanks for calling ${firmName}. I'm ${aName}, your virtual receptionist. How can I help you today?`).slice(0, 200);
  const key = await synthesizeToDisk(text);
  if (!key) return reply.code(503).send({ error: 'TTS unavailable' });
  const audio = await fs.readFile(path.join(AUDIO_DIR, `${key}.mp3`));
  reply.header('Content-Type', 'audio/mpeg');
  reply.header('Cache-Control', 'no-store');
  return reply.send(audio);
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

  // Rate limiting: per-IP (10 req/min) and per-firmId (100 calls/day)
  const clientIp = req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(`ip:${clientIp}`, 10, 60_000)) {
    reply.header('Content-Type', 'text/xml');
    app.log.warn({ clientIp, firmId }, 'rate limit hit (IP)');
    return reply.send(doneTwiml({ speakText: "We're experiencing high call volume. Please try again in a moment.", ttsKey: null }));
  }
  if (!checkRateLimit(`firm:${firmId}`, 100, 86_400_000)) {
    reply.header('Content-Type', 'text/xml');
    app.log.warn({ firmId }, 'rate limit hit (firm)');
    return reply.send(doneTwiml({ speakText: "We're currently at capacity. Please try again later.", ttsKey: null }));
  }

  // Answering machine / voicemail detection
  const answeredBy = String(req.body?.AnsweredBy || '').trim();
  if (answeredBy === 'machine_start' || answeredBy === 'fax') {
    const vmConfig = await loadFirmConfig(firmId);
    reply.header('Content-Type', 'text/xml');
    return reply.send(voicemailTwiml({ firmId, callSid, fromPhone, firmConfig: vmConfig }));
  }

  try {
    const firmConfig = await loadFirmConfig(firmId);
    const sessions = await loadSessions();
    let session = sessions[callSid];
    if (!session) {
      session = createSession({ callSid, firmId, fromPhone, firmConfig });
      sessions[callSid] = session;
      await saveSessions(sessions);
      // Register statusCallback on the live call so we capture partial leads on hangup
      if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
        const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
        fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            StatusCallback: `${PUBLIC_BASE_URL}/call-status`,
            StatusCallbackMethod: 'POST',
          }).toString(),
        }).catch((err) => app.log.warn({ err: String(err), callSid }, 'statusCallback registration failed'));
      }
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
        fireNotifications(session, firmConfig);
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

    const practiceHints = (firmConfig.practice_areas || []).join(', ');
    return reply.send(
      gatherTwiml({
        actionUrl: `${PUBLIC_BASE_URL}/twiml?firmId=${encodeURIComponent(firmId)}`,
        speakText,
        ttsKey,
        emptyCount: session.repromptCount,
        hints: practiceHints,
      })
    );
  } catch (err) {
    app.log.error({ err: String(err), callSid }, '/twiml failed');
    reply.header('Content-Type', 'text/xml');
    return reply.send(doneTwiml({ speakText: 'Sorry, there was a technical issue. Please call again.', ttsKey: null }));
  }
});

// POST /call-status — Twilio status callback; saves partial leads on hangup
app.post('/call-status', async (req, reply) => {
  const callSid = String(req.body?.CallSid || '').trim();
  const callStatus = String(req.body?.CallStatus || '').trim();

  if (callStatus !== 'completed' || !callSid) return reply.code(204).send();

  const sessions = await loadSessions();
  const session = sessions[callSid];

  // Session already marked done — full lead already saved, nothing to do
  if (!session || session.done) return reply.code(204).send();

  // Caller hung up before intake completed — persist as partial lead
  app.log.info({ callSid, leadId: session.leadId }, 'call-status: saving partial lead');

  try {
    await persistSessionArtifacts(session, { assistantText: '', callerText: '', done: false });
    await patchLead(session.leadId, { status: 'partial' });

    const firmConfig = await loadFirmConfig(session.firmId || 'firm_default');
    sendPartialEmailNotification(session, firmConfig)
      .catch((err) => app.log.warn({ err: String(err), leadId: session.leadId }, 'partial email failed'));
    const partialLead = { id: session.leadId, firmId: session.firmId, fromPhone: session.fromPhone, status: 'partial', ...session.collected };
    fireWebhooks(partialLead, session.firmId, firmConfig);
  } catch (err) {
    app.log.warn({ err: String(err), callSid }, 'call-status: partial lead save failed');
  }

  return reply.code(204).send();
});

// POST /voicemail-recording — Twilio Record action callback; transcribes + saves voicemail lead
app.post('/voicemail-recording', async (req, reply) => {
  reply.header('Content-Type', 'text/xml');
  const emptyResponse = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;

  const recordingUrl = String(req.body?.RecordingUrl || '').trim();
  const callSid = String(req.body?.CallSid || req.query?.callSid || '').trim();
  const firmId = String(req.body?.firmId || req.query?.firmId || 'firm_default').trim();
  const fromPhone = normalizePhone(req.body?.From || req.query?.from || '');

  if (!callSid) return reply.send(emptyResponse);

  app.log.info({ callSid, recordingUrl, firmId, fromPhone }, 'voicemail-recording received');

  try {
    let transcript = '';
    if (recordingUrl && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && OPENAI_API_KEY) {
      const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
      const audioRes = await fetch(`${recordingUrl}.mp3`, {
        headers: { Authorization: `Basic ${auth}` },
      }).catch(() => null);

      if (audioRes?.ok) {
        const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
        const formData = new FormData();
        formData.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'voicemail.mp3');
        formData.append('model', 'whisper-1');
        const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
          body: formData,
        }).catch(() => null);
        if (whisperRes?.ok) {
          const data = await whisperRes.json().catch(() => ({}));
          transcript = String(data.text || '').trim();
        }
      }
    }

    const firmConfig = await loadFirmConfig(firmId);
    const leadId = `lead_${sha1(`${firmId}|${fromPhone}`)}`;
    const now = nowIso();
    const fakeSession = {
      callSid, firmId, fromPhone,
      callId: `call_${sha1(`${callSid}|${firmId}`)}`,
      leadId,
      collected: {
        full_name: '',
        callback_number: fromPhone,
        practice_area: '',
        case_summary: transcript,
      },
      callerType: null,
      isUrgent: false,
      transcript: transcript ? [{ role: 'caller', text: transcript, ts: now }] : [],
      done: false,
      createdAt: now,
      updatedAt: now,
    };

    await persistSessionArtifacts(fakeSession, { assistantText: '', callerText: transcript, done: false });
    await patchLead(leadId, { status: 'voicemail' });

    sendVoicemailEmailNotification({ fromPhone, transcript, firmConfig, leadId })
      .catch((err) => app.log.warn({ err: String(err), leadId }, 'voicemail email failed'));
  } catch (err) {
    app.log.warn({ err: String(err), callSid }, 'voicemail-recording handler failed');
  }

  return reply.send(emptyResponse);
});

// ── Stripe billing routes ─────────────────────────────────────────────────────

// POST /api/billing/checkout — creates a Stripe Checkout session for a firm
app.post('/api/billing/checkout', async (req, reply) => {
  if (!stripe) return reply.code(503).send({ error: 'Billing not configured' });
  const firmId = String(req.body?.firmId || '').trim();
  if (!firmId) return reply.code(400).send({ error: 'firmId required' });
  if (!STRIPE_PRICE_ID) return reply.code(503).send({ error: 'STRIPE_PRICE_ID not set' });

  const firm = await loadFirmConfig(firmId);

  // Reuse existing customer or create a new one
  let customerId = firm.stripe_customer_id || null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: firm.name || firmId,
      metadata: { firmId },
    });
    customerId = customer.id;
    await saveFirmConfig(firmId, { ...firm, stripe_customer_id: customerId });
  }

  const fromSignup = req.body?.fromSignup === true;
  const successUrl = `${WEB_BASE_URL}/billing/success?firmId=${encodeURIComponent(firmId)}${fromSignup ? '&signup=1' : ''}`;
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
    success_url: successUrl,
    cancel_url: `${WEB_BASE_URL}/billing/cancel?firmId=${encodeURIComponent(firmId)}`,
    metadata: { firmId },
  });

  return { url: session.url };
});

// POST /api/billing/portal — opens Stripe Customer Portal for a firm
app.post('/api/billing/portal', async (req, reply) => {
  if (!stripe) return reply.code(503).send({ error: 'Billing not configured' });
  const firmId = String(req.body?.firmId || '').trim();
  if (!firmId) return reply.code(400).send({ error: 'firmId required' });

  const firm = await loadFirmConfig(firmId);
  if (!firm.stripe_customer_id) {
    return reply.code(400).send({ error: 'No billing account found for this firm' });
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: firm.stripe_customer_id,
    return_url: `${WEB_BASE_URL}/clients/${firmId}`,
  });

  return { url: session.url };
});

// POST /api/resend-instructions — resend Twilio setup email to a firm
function requireAdminKey(req, reply) {
  if (!ADMIN_API_KEY) return; // No key configured — skip check (dev mode)
  const provided = req.headers?.['x-admin-key'] || '';
  if (provided !== ADMIN_API_KEY) {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/api/admin/rate-limits', async (req, reply) => {
  if (requireAdminKey(req, reply) === false) return;
  const now = Date.now();
  const entries = [];
  for (const [key, hits] of rateLimitStore.entries()) {
    const recentHits = hits.filter((t) => t > now - 60_000).length;
    const dayHits = hits.filter((t) => t > now - 86_400_000).length;
    entries.push({ key, hitsLastMinute: recentHits, hitsToday: dayHits });
  }
  return { entries: entries.sort((a, b) => b.hitsToday - a.hitsToday) };
});

app.get('/api/admin/overview', async (req, reply) => {
  if (requireAdminKey(req, reply) === false) return;
  const [allCalls, allLeads, allFirms] = await Promise.all([loadCalls(), loadLeads(), listFirmConfigs()]);
  const now = Date.now();
  const monthCutoff = new Date(now - 30 * 86_400_000).toISOString();

  const firmStats = allFirms.map((firm) => {
    const firmCalls = allCalls.filter((c) => c.firmId === firm.id);
    const monthCalls = firmCalls.filter((c) => c.startedAt >= monthCutoff);
    const completed = monthCalls.filter((c) => c.outcome === 'intake_complete').length;
    const completionRate = monthCalls.length > 0 ? Math.round((completed / monthCalls.length) * 100) : 0;
    const lastCall = firmCalls.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.startedAt || null;
    return {
      id: firm.id,
      name: firm.name,
      billing_status: firm.billing_status || 'unknown',
      callsThisMonth: monthCalls.length,
      completionRate,
      lastCallAt: lastCall,
    };
  }).sort((a, b) => b.callsThisMonth - a.callsThisMonth);

  const totalFirms = allFirms.length;
  const totalLeads = allLeads.length;
  const totalCalls = allCalls.length;

  return { totalFirms, totalLeads, totalCalls, firms: firmStats };
});

app.get('/api/analytics/:firmId', async (req, reply) => {
  const { firmId } = req.params;
  const days = Math.min(Number(req.query?.days || 30), 365);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

  const [allCalls, allLeads] = await Promise.all([loadCalls(), loadLeads()]);
  const calls = allCalls.filter((c) => c.firmId === firmId && c.startedAt >= cutoff);
  const leads = allLeads.filter((l) => l.firmId === firmId && l.createdAt >= cutoff);

  const totalCalls = calls.length;
  const completed = calls.filter((c) => c.outcome === 'intake_complete').length;
  const partial = leads.filter((l) => l.status === 'partial').length;
  const voicemails = leads.filter((l) => l.status === 'voicemail').length;
  const completionRate = totalCalls > 0 ? Math.round((completed / totalCalls) * 100) : 0;

  // Average duration (endedAt - startedAt in seconds)
  const durationsMs = calls
    .filter((c) => c.endedAt && c.startedAt)
    .map((c) => new Date(c.endedAt).getTime() - new Date(c.startedAt).getTime());
  const avgDuration = durationsMs.length > 0 ? Math.round(durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length / 1000) : 0;

  // Calls by day (last `days` days)
  const dayMap = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    dayMap[d] = 0;
  }
  for (const c of calls) {
    const d = String(c.startedAt || '').slice(0, 10);
    if (d in dayMap) dayMap[d]++;
  }
  const callsByDay = Object.entries(dayMap).map(([date, count]) => ({ date, count }));

  // Top practice areas
  const areaMap = {};
  for (const l of leads) {
    const area = l.practice_area || 'Unknown';
    areaMap[area] = (areaMap[area] || 0) + 1;
  }
  const topPracticeAreas = Object.entries(areaMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([area, count]) => ({ area, count }));

  return { totalCalls, completed, partial, voicemails, avgDuration, completionRate, callsByDay, topPracticeAreas };
});

app.get('/api/webhook-logs/:firmId', async (req, reply) => {
  const { firmId } = req.params;
  const limit = Math.min(Number(req.query?.limit || 50), 200);
  const logs = await getWebhookLogs(firmId, limit);
  return { data: logs };
});

app.post('/api/test-webhook', async (req, reply) => {
  const firmId = String(req.body?.firmId || '').trim();
  if (!firmId) return reply.code(400).send({ error: 'firmId required' });
  const firmConfig = await loadFirmConfig(firmId);
  if (!firmConfig.webhook_url) return reply.code(400).send({ error: 'No webhook_url configured for this firm' });

  const fakeLead = {
    id: 'lead_test_' + Date.now(),
    firmId,
    fromPhone: '+15555550000',
    full_name: 'Test Caller',
    callback_number: '+15555550000',
    practice_area: firmConfig.practice_areas?.[0] || 'General',
    case_summary: 'This is a test webhook payload from Ava.',
    status: 'ready_for_review',
    caller_type: 'new',
  };

  try {
    const res = await fetch(firmConfig.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'lead.test', lead: fakeLead, firm_id: firmId, timestamp: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, body: body.slice(0, 500) };
  } catch (err) {
    return reply.code(502).send({ error: String(err) });
  }
});

app.post('/api/resend-instructions', async (req, reply) => {
  const firmId = String(req.body?.firmId || '').trim();
  if (!firmId) return reply.code(400).send({ error: 'firmId required' });
  const firm = await loadFirmConfig(firmId);
  if (!firm.notification_email) return reply.code(400).send({ error: 'No notification email on file' });
  if (!RESEND_API_KEY) return reply.code(503).send({ error: 'Email not configured' });
  await sendWelcomeEmail(firm);
  return { ok: true };
});

// POST /api/billing/webhook — Stripe webhook handler
app.post('/api/billing/webhook', async (req, reply) => {
  if (!stripe) return reply.code(503).send({ error: 'Billing not configured' });

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    app.log.warn({ err: String(err) }, 'Stripe webhook signature verification failed');
    return reply.code(400).send({ error: 'Invalid signature' });
  }

  const obj = event.data.object;

  if (event.type === 'checkout.session.completed') {
    const firmId = obj.metadata?.firmId;
    if (firmId) {
      const firm = await loadFirmConfig(firmId);
      await saveFirmConfig(firmId, {
        ...firm,
        stripe_customer_id: obj.customer,
        stripe_subscription_id: obj.subscription,
        billing_status: 'active',
      });
    }
  } else if (event.type === 'customer.subscription.updated') {
    const firmId = obj.metadata?.firmId;
    if (firmId) {
      const firm = await loadFirmConfig(firmId);
      await saveFirmConfig(firmId, {
        ...firm,
        stripe_subscription_id: obj.id,
        billing_status: obj.status === 'active' ? 'active' : obj.status,
      });
    }
  } else if (event.type === 'customer.subscription.deleted') {
    const firmId = obj.metadata?.firmId;
    if (firmId) {
      const firm = await loadFirmConfig(firmId);
      await saveFirmConfig(firmId, { ...firm, billing_status: 'canceled' });
    }
  }

  return { received: true };
});

// ── Boot ──────────────────────────────────────────────────────────────────────

app.log.info(`BOOT PORT=${PORT} PUBLIC_BASE_URL=${PUBLIC_BASE_URL}`);
app.log.info({
  RESEND_API_KEY_prefix:     RESEND_API_KEY     ? RESEND_API_KEY.slice(0, 4)     : '(unset)',
  RESEND_FROM_EMAIL,
  TWILIO_ACCOUNT_SID_prefix: TWILIO_ACCOUNT_SID ? TWILIO_ACCOUNT_SID.slice(0, 4) : '(unset)',
  TWILIO_FROM_NUMBER,
}, 'BOOT notification config');
app.log.info({
  ELEVENLABS_MODEL_ID,
  ELEVENLABS_VOICE_ID: ELEVENLABS_VOICE_ID ? ELEVENLABS_VOICE_ID.slice(0, 8) + '...' : '(unset)',
  ELEVEN_STABILITY:     process.env.ELEVEN_STABILITY     ?? '(default 0.55)',
  ELEVEN_SIMILARITY:    process.env.ELEVEN_SIMILARITY    ?? '(default 0.85)',
  ELEVEN_STYLE:         process.env.ELEVEN_STYLE         ?? '(default 0.15)',
  ELEVEN_SPEAKER_BOOST: process.env.ELEVEN_SPEAKER_BOOST ?? '(default true)',
}, 'BOOT ElevenLabs voice config');

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`HTTP listening on http://127.0.0.1:${PORT}`);
  prewarmTtsCache().catch((err) => app.log.warn({ err: String(err) }, 'TTS prewarm error'));
} catch (err) {
  app.log.error({ err: String(err) }, 'Server failed to start');
  process.exit(1);
}