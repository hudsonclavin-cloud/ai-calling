import 'dotenv/config';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import Stripe from 'stripe';
import crypto from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initSchema,
  migrateFromJson,
  loadCalls,
  loadLeads,
  getCallById,
  getCallByCallSid,
  getLeadsByPhone,
  loadSessions,
  saveSessions,
  deleteSession,
  persistSessionArtifacts,
  patchLead,
  getLeadById,
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
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'XrExE9yKIg1WjnnlVkGX'; // Matilda (warm, conversational)
// eleven_turbo_v2_5: latency-optimized for streaming (recommended for phone)
// eleven_flash_v2_5: newer, may offer better expressiveness — test latency before switching
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

const TONE_PRESETS = {
  warm:         "Your tone is warm, empathetic, and unhurried. Use contractions naturally. Show genuine care. Never robotic.",
  professional: "Your tone is polished and precise. Minimal small talk. Use 'Certainly' not 'Sure'. Address callers by last name if given. Efficient and respectful.",
  friendly:     "Your tone is upbeat and conversational. Short, punchy sentences. Sound like a helpful person — not a corporate recording.",
};

const INDUSTRY_MODULES = {
  law_pi: `INDUSTRY CONTEXT — PERSONAL INJURY LAW:
Callers are typically injured individuals or their families seeking legal help after accidents, slip-and-falls, medical malpractice, defective products, or workplace injuries. Most work on a contingency fee basis (no fee unless the firm wins). Key intake info: accident date, injury type, who was at fault, medical treatment status, insurance involvement. Urgency signals: still receiving treatment, recent accident, upcoming statute of limitations. Common terminology: liability, negligence, damages, settlement, insurance adjuster.`,

  law_family: `INDUSTRY CONTEXT — FAMILY LAW:
Callers are often emotionally distressed, dealing with divorce, custody disputes, child support, domestic violence, or adoption. Be especially calm and empathetic. Many callers are in the middle of an emotional crisis. Key intake info: type of matter, whether it's contested, if there are children involved, current legal status. Urgency signals: safety concerns, immediate court dates, protective order needs. Common terminology: dissolution, custody, visitation, spousal support, guardian ad litem.`,

  law_criminal: `INDUSTRY CONTEXT — CRIMINAL DEFENSE:
Callers may be recently arrested, under investigation, or calling for a family member. Tone should be non-judgmental, reassuring, and focused on next steps. Key intake info: charge or alleged offense, jurisdiction, court date if any, custody status. Urgency signals: currently in custody, court tomorrow, recent arrest. Do NOT ask for extensive case details — just name, phone, and basic situation. Common terminology: arraignment, bail, plea, public defender, charges, indictment.`,

  medical: `INDUSTRY CONTEXT — MEDICAL / HEALTHCARE:
Callers may be patients, caregivers, or family members seeking medical consultations, billing help, or scheduling. Be compassionate — health matters are personal. Key intake info: reason for call, insurance status, urgency of medical need. Urgency signals: active symptoms, prescription issues, test results. Maintain HIPAA-conscious language — do not solicit overly specific health details upfront. Common terminology: referral, provider, co-pay, prior authorization, specialist.`,

  real_estate: `INDUSTRY CONTEXT — REAL ESTATE:
Callers may be buyers, sellers, investors, landlords, or tenants. Topics include buying/selling property, lease disputes, title issues, closings, or investment inquiries. Key intake info: property type, transaction type, location, timeline. Urgency signals: closing date approaching, lease expiring, eviction notice received. Common terminology: escrow, title, closing costs, earnest money, deed, comps, contingency.`,

  home_services: `INDUSTRY CONTEXT — HOME SERVICES:
Callers need help with home repair, HVAC, plumbing, electrical, roofing, or similar services. Often calling due to a specific problem (leak, broken unit, damage). Key intake info: type of service needed, urgency, property type, location. Urgency signals: active leak, no heat in winter, safety hazard. Be practical and action-oriented. Common terminology: estimate, service call, warranty, inspection, permit, installation.`,

  general: `INDUSTRY CONTEXT — GENERAL SMALL BUSINESS:
Callers may have a wide variety of needs. Be flexible and listen carefully to understand what they need before asking intake questions. Key intake info: name, callback number, reason for call. Focus on capturing contact info and a clear reason for the inquiry so the business can follow up appropriately.`,
};

const INDUSTRY_REQUIRED_FIELDS = {
  law_pi:       ['full_name', 'callback_number', 'practice_area', 'case_summary'],
  law_family:   ['full_name', 'callback_number', 'practice_area', 'case_summary'],
  law_criminal: ['full_name', 'callback_number', 'practice_area', 'case_summary'],
  medical:      ['full_name', 'callback_number', 'practice_area', 'case_summary'],
  real_estate:  ['full_name', 'callback_number', 'practice_area', 'case_summary'],
  home_services:['full_name', 'callback_number', 'practice_area', 'case_summary'],
  general:      ['full_name', 'callback_number', 'practice_area'],
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FIRMS_DIR = path.join(DATA_DIR, 'firms');       // per-firm config JSON files
const CALLS_FILE = path.join(DATA_DIR, 'calls.json');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const AUDIO_DIR = path.join(DATA_DIR, 'tts_audio');

// Pre-synthesized hold phrase — used as fallback whenever a TTS key is unavailable
const HOLD_PHRASE = 'One moment please.';
let holdKey = null; // set at boot before prewarm

// Thinking filler phrases — played immediately when caller finishes speaking, before OpenAI responds
const FILLER_PHRASES = [
  'One moment.',
  'Just a sec.',
  'Okay, hold on.',
  'Mm, one moment.',
  'Right with you.',
  'Let me grab that.',
  'One second.',
  'Hold on just a moment.',
  'Okay.',
  'Sure, one sec.',
  "Let me look that up.",
  "Hold tight.",
  "Give me just a second.",
  "One sec, let me check.",
  "Mm, let me see.",
  "Hang on just a moment.",
  "Bear with me one sec.",
  "Let me pull that up.",
  "Okay, just a moment.",
  "Mm-hm, one second.",
  "Let me make a note of that.",
  "Right, one moment.",
  "Hold on, let me check.",
  "Okay, give me just a sec.",
  "Let me find that for you.",
  "Just a moment.",
];
let fillerKeys = []; // populated at boot via synthesizeToDisk

// Per-session last filler index (avoids consecutive repeated filler within a call)
const fillerLastIdxMap = new Map();
const DYNAMIC_FILLER_TIMEOUT_MS = Number(process.env.DYNAMIC_FILLER_TIMEOUT_MS ?? 800);

// ── Default firm config (used as fallback if no file found) ──────────────────
// To add a new firm: copy firm_default.json → firm_yourname.json and edit it.
// That's it. No code changes needed.
const DEFAULT_FIRM_CONFIG = {
  id: 'firm_default',
  name: 'Redwood Legal Group',
  ava_name: 'Ava',
  tone: 'warm',
  industry: 'law_pi',
  opening: "Hi, thanks for calling Redwood Legal Group — this is Ava. What can I help you with today?",
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
  acknowledgments: ['Got it.', 'Makes sense.', 'Okay.', 'Right.', 'Mm-hm.', 'I hear you.', 'Understood.'],
  max_questions: 8,
  max_reprompts: 2,
  office_hours: 'Mon-Fri 8:00 AM - 6:00 PM',
  business_hours: null,
  timezone: 'America/New_York',
  disclaimer: 'This call is informational only and does not create an attorney-client relationship.',
  intake_rules: 'Collect caller contact details and a short case summary. Escalate emergency threats to 911 guidance.',
  notification_email: '',
  notification_phone: '',
  greeting_style: 'casual',
  custom_intro: null,
  reprompt_phrases: null,
  early_exit_phrases: null,
  urgency_phrases: null,
};

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const app = Fastify({ logger: true });

// Log which critical env vars are present at boot (no values, just presence flags)
app.log.info({
  OPENAI_API_KEY:    !!OPENAI_API_KEY,
  ELEVENLABS_API_KEY: !!ELEVENLABS_API_KEY,
  RESEND_API_KEY:    !!RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  TWILIO_ACCOUNT_SID: !!TWILIO_ACCOUNT_SID,
  STRIPE_SECRET_KEY:  !!STRIPE_SECRET_KEY,
  WEB_BASE_URL,
  ADMIN_API_KEY:      !!ADMIN_API_KEY,
  DEMO_PHONE_NUMBER: process.env.DEMO_PHONE_NUMBER || '(not set)',
}, 'BOOT env check');
if (RESEND_FROM_EMAIL.endsWith('@resend.dev')) {
  app.log.warn({ RESEND_FROM_EMAIL }, 'EMAIL WARNING: RESEND_FROM_EMAIL uses Resend sandbox domain — emails can only be delivered to the Resend account owner\'s address. Set RESEND_FROM_EMAIL to a verified sender domain for production.');
}
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
// Stores in-flight runNextStepController promises keyed by callSid so /twiml-result can await them
const pendingResponses = new Map(); // callSid → { promise, t0 }

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

// ── Customizable phrase helpers ───────────────────────────────────────────────

function getEarlyExitPhrase(firmConfig) {
  const phrases = [
    firmConfig.early_exit_phrases?.[0] || "No problem — call us back anytime. Take care!",
    firmConfig.early_exit_phrases?.[1] || "That's totally fine. We're here whenever you need us.",
    firmConfig.early_exit_phrases?.[2] || "Not a problem at all. Just give us a ring when you're ready.",
    firmConfig.early_exit_phrases?.[3] || "We'll be here. Take care!",
  ];
  return phrases[Math.floor(Math.random() * phrases.length)];
}

function getRepromptPhrases(firmConfig) {
  if (firmConfig.reprompt_phrases) return firmConfig.reprompt_phrases;
  return [
    null,
    "Let me make sure I got that right — {QUESTION}",
    "Could you say that one more time? {QUESTION}",
  ];
}

function getRepromptClosePhrase(firmConfig, closing) {
  const phrases = [
    firmConfig.reprompt_phrases?.[3] || `No worries — I've got your call noted. ${closing}`,
    firmConfig.reprompt_phrases?.[4] || `That's okay — I'll make sure someone reaches out. ${closing}`,
  ];
  return phrases[Math.floor(Math.random() * phrases.length)];
}

function getUrgencyOpener(firmConfig, session) {
  const openers = firmConfig.urgency_phrases || [
    "Oh no — I'm really glad you called. You're in the right place and I want to make sure we get the right person on this.",
    "I hear you — that sounds serious, and we're going to make sure you're taken care of.",
    "I'm so glad you reached out. Let me make sure we get the right attorney on this right away.",
    "Oh gosh — thank you for calling. You're in exactly the right place and help is coming.",
    "That sounds really difficult, and I'm glad you called. Let me make sure we get you to the right person.",
  ];
  const lastIdx = session.lastUrgencyOpenerIdx ?? -1;
  let idx;
  do {
    idx = Math.floor(Math.random() * openers.length);
  } while (openers.length > 1 && idx === lastIdx);
  session.lastUrgencyOpenerIdx = idx;
  return openers[idx];
}

function getReturningGreeting(firstName, firmConfig) {
  const style = firmConfig.greeting_style || 'casual';
  if (style === 'formal') {
    const phrases = [
      `Hello ${firstName}, welcome back. How may I assist you today?`,
      `Good to have you back, ${firstName}. How can I help you?`,
    ];
    return phrases[Math.floor(Math.random() * phrases.length)];
  }
  const phrases = [
    `Welcome back, ${firstName}! What can I help you with today?`,
    `Hey ${firstName} — good to hear from you again. What brings you in today?`,
    `${firstName}, welcome back! How can I help?`,
  ];
  return phrases[Math.floor(Math.random() * phrases.length)];
}

const PHONE_RETRY_PHRASES = [
  "I want to make sure I have your number right — could you say it one more time, a little slowly?",
  "Just want to double-check your number — could you repeat it for me?",
  "I didn't quite catch all the digits — could you say your number once more?",
];

const RATE_LIMIT_MESSAGES = [
  "I'm so sorry — we're getting a lot of calls right now. Please try again in just a moment, and we'll be right with you.",
  "I apologize — our lines are unusually busy right now. Please try again shortly and someone will be with you soon.",
];

const SUSPENDED_MESSAGE = "I'm sorry — this number isn't currently active. Please contact the business directly for assistance.";

const TRIAL_EXPIRED_MESSAGE = "I'm sorry — this service isn't currently available. Please contact the business directly for assistance.";

const ERROR_MESSAGES = [
  "I'm so sorry — something went wrong on my end. Please give us a call back in just a moment.",
  "I apologize — I ran into a technical issue. Please try calling again and I'll be right with you.",
];

function getErrorMessage() {
  return ERROR_MESSAGES[Math.floor(Math.random() * ERROR_MESSAGES.length)];
}

// ── LLM Response Validators ───────────────────────────────────────────────────

function similarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  return intersection / Math.max(wordsA.size, wordsB.size, 1);
}

function validateLlmResponse(llm, session, app) {
  if (!llm) return null;
  const text = String(llm.next_question_text || '').trim();
  const ROBOTIC_PHRASES = /^(noted\.|i understand\.|i see\.|certainly\.|of course\.|sure\.|okay\.|got it\.|understood\.|thank you\.)$/i;
  const isEmpty = text.length < 15;
  const isRobotic = ROBOTIC_PHRASES.test(text);
  const lastSpoken = (session.transcript || []).filter(t => t.role === 'assistant').slice(-1)[0]?.text || '';
  const isRepeat = lastSpoken && similarity(text, lastSpoken) > 0.75;
  if (isEmpty || isRobotic || isRepeat) {
    app.log.warn({ callSid: session.callSid, text, isEmpty, isRobotic, isRepeat }, '[LLM-VALIDATE] response failed quality check — falling to deterministic');
    return { ...llm, next_question_text: '' };
  }
  return llm;
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
  const industry = raw.industry || DEFAULT_FIRM_CONFIG.industry;
  return {
    ...DEFAULT_FIRM_CONFIG,
    ...raw,
    question_overrides: { ...DEFAULT_FIRM_CONFIG.question_overrides, ...(raw.question_overrides || {}) },
    acknowledgments: raw.acknowledgments?.length ? raw.acknowledgments : DEFAULT_FIRM_CONFIG.acknowledgments,
    required_fields: raw.required_fields?.length ? raw.required_fields : (INDUSTRY_REQUIRED_FIELDS[industry] || REQUIRED_FIELDS_DEFAULT),
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

// ── Business hours ────────────────────────────────────────────────────────────

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function nextOpenDay(schedule, currentDay) {
  const startIdx = DAY_NAMES.indexOf(currentDay);
  for (let i = 1; i <= 7; i++) {
    const name = DAY_NAMES[(startIdx + i) % 7];
    if (schedule[name]) {
      return i === 1 ? 'tomorrow morning' : `${name.charAt(0).toUpperCase() + name.slice(1)} morning`;
    }
  }
  return null;
}

function isWithinBusinessHours(firmConfig) {
  const tz = firmConfig.timezone || 'America/New_York';
  const schedule = firmConfig.business_hours || {
    monday: { open: '09:00', close: '17:00' }, tuesday: { open: '09:00', close: '17:00' },
    wednesday: { open: '09:00', close: '17:00' }, thursday: { open: '09:00', close: '17:00' },
    friday: { open: '09:00', close: '17:00' }, saturday: null, sunday: null,
  };
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(now).map(p => [p.type, p.value])
  );
  const dayName = parts.weekday.toLowerCase();
  const cur = parseInt(parts.hour) * 60 + parseInt(parts.minute);
  const day = schedule[dayName];
  if (!day) return { isOpen: false, nextOpen: nextOpenDay(schedule, dayName) };
  const [oh, om] = day.open.split(':').map(Number);
  const [ch, cm] = day.close.split(':').map(Number);
  const isOpen = cur >= oh * 60 + om && cur < ch * 60 + cm;
  return { isOpen, nextOpen: isOpen ? null : nextOpenDay(schedule, dayName) };
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
  collected.calling_for = '';

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
    knownName: '',             // set when returning caller is detected with a known name
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
  if (/\b(existing|returning|current client|already (a client|working with you|have a case here)|i('ve| have) called (you|here|before|already)|previous(ly)?|already a client|you (already )?have my (info|information|number|file))\b/.test(lower)) return 'returning';
  return null;
}

function detectUrgency(text) {
  const lower = String(text || '').toLowerCase();
  return /\b(arrested|in jail|emergency|evicted today|court tomorrow|restraining order|accident just happened|just had an accident|just was in an accident|in (a bad|a terrible|a serious) accident|injured right now|going to jail|being evicted|just got hurt|seriously hurt|car accident|hit by a car|i'?m scared|really scared|at the hospital right now|in the hospital right now)\b/.test(lower);
}

function detectEarlyExit(text) {
  const lower = String(text || '').toLowerCase();
  // Only fire on unambiguous, explicit exit signals — never on colloquial phrases like
  // "I'm fine" or "don't worry" which callers say mid-conversation without meaning to hang up.
  return /\b(never\s*mind|nevermind|forget it|i('ll| will) call back|i'?ll try again|good\s*bye|i'?m done|no thanks|not interested|i changed my mind|scratch that|disregard|i('ll| will) call back later|i don'?t need help|i'?m (all set|good for now)|end (the )?call)\b/.test(lower);
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
      nextQuestionText: PHONE_RETRY_PHRASES[Math.floor(Math.random() * PHONE_RETRY_PHRASES.length)],
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

function callOpenAiForNextStep({ firmConfig, session, userText }) {
  if (!OPENAI_API_KEY) {
    return { earlyTextPromise: Promise.resolve(null), result: Promise.resolve(null) };
  }

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
          calling_for: { type: 'string' },
        },
        required: ['full_name', 'callback_number', 'practice_area', 'case_summary', 'caller_type', 'calling_for'],
      },
      next_question_id: { type: 'string' },
      next_question_text: { type: 'string' },
      done_reason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      clarifying_note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['extracted', 'next_question_id', 'next_question_text', 'done_reason', 'clarifying_note'],
  };

  const wordCount = userText.split(/\s+/).filter(Boolean).length;

  // Trim long fields to avoid bloating the payload
  const collectedForPrompt = { ...session.collected };
  if (collectedForPrompt.case_summary?.length > 200) {
    collectedForPrompt.case_summary = collectedForPrompt.case_summary.slice(0, 200);
  }

  // Last 4 turns of conversation so LLM maintains emotional continuity across turns
  const recentTranscript = session.transcript
    .slice(-8)
    .map((t) => `${t.role === 'caller' ? 'Caller' : 'Ava'}: ${t.text}`)
    .join('\n');

  const prompt = {
    conversation_so_far: recentTranscript || null,
    previous_exchange: {
      ava_asked: session.lastQuestionText || null,
      caller_said: userText,
    },
    practice_areas: firmConfig.practice_areas,
    intake_rules: firmConfig.intake_rules ? String(firmConfig.intake_rules).slice(0, 500) : null,
    required_fields: requiredFields,
    asked_question_ids: session.askedQuestionIds,
    current_collected: collectedForPrompt,
    is_rambling: wordCount > 150,
    caller_is_urgent: session.isUrgent,
  };

  app.log.info({ chars: JSON.stringify(prompt).length }, 'openai-payload-chars');

  const toneInstruction = TONE_PRESETS[firmConfig.tone] || TONE_PRESETS['warm'];

  const { isOpen, nextOpen } = isWithinBusinessHours(firmConfig);
  const hoursStr = firmConfig.office_hours ? ` (${firmConfig.office_hours})` : '';
  const hoursContext = isOpen
    ? `The office is currently open${hoursStr}. You may tell the caller someone will be in touch shortly.`
    : `The office is currently closed${hoursStr}. Let the caller know their info is captured and someone will follow up when the office reopens${nextOpen ? ` (${nextOpen})` : ''}.`;

  const industryContext = INDUSTRY_MODULES[firmConfig.industry] || INDUSTRY_MODULES['law_pi'];

  const ava_name = firmConfig.ava_name || 'Ava';
  const firm_name = firmConfig.name;
  const requiredFieldsList = requiredFields.join(' | ');

  const systemPrompt = `You are ${ava_name}, a real receptionist at ${firm_name}. You are a person — not a bot, not a checklist, not an AI. Speak like one.

${toneInstruction}

EVERY RESPONSE — no exceptions:
Your next_question_text MUST begin with a natural, human acknowledgment of what the caller just said. React to the actual content of their words. Never launch straight into a question. Never start with "So," "Alright," or "Great."
- If they told you something hard, show it: "Oh gosh, I'm sorry you're dealing with that."
- If they gave their name, use it: "Nice to meet you, [name]."
- If they were brief, mirror that brevity — a short "Got it" style reaction, then the question.
- NEVER say: "Of course.", "Sure thing.", "Absolutely.", "Thanks for sharing that.", "I understand your concern", "Certainly!", "I appreciate you reaching out."

Use contractions always. Keep responses to 1-2 sentences. Leave room for them to talk.

Mirror their words exactly — if they say "car accident," say "car accident," not "motor vehicle incident."
Never ask for info they already gave. Never ask two things at once. Weave questions in naturally: "And who am I speaking with?" not "What is your name?"

ENDING THE CALL — set next_question_id to "done" only when ALL are true:
1. You have their name.
2. You have their phone number.
3. You have a real description of what happened (not just a one-word category).
4. You know roughly when it happened.
5. The caller sounds ready to wrap up — slowing down, said "okay" or "alright," trailing off naturally.

If ANY is missing, keep going. Never rush to close.

next_question_id MUST be one of: full_name | callback_number | practice_area | case_summary | done
Use "done" only when all required fields are collected AND the caller sounds genuinely done.

REQUIRED FIELDS: ${requiredFieldsList}

OFFICE HOURS: ${hoursContext}

${industryContext}

TTS — YOUR TEXT WILL BE READ ALOUD, NOT READ ON SCREEN:
- Use em-dashes for natural thinking pauses: "Oh — that sounds really hard."
- Use "..." for soft trailing questions: "And your name is...?"
- NEVER write digits for phone numbers: write "five five five, zero one four two" not "555-0142"
- NEVER write "$": write "five hundred dollars" not "$500"
- One breath per sentence. Two thoughts? Connect with a dash, not a period.

Return only strict JSON per schema.`;

  app.log.info({
    tag: '[LLM-IN]',
    callSid: session.callSid,
    model: OPENAI_MODEL,
    systemPromptChars: systemPrompt.length,
    requiredFields,
    askedIds: session.askedQuestionIds,
    collectedKeys: Object.keys(session.collected).filter(k => session.collected[k]),
    isUrgent: session.isUrgent,
    callerType: session.callerType,
  }, '[LLM-IN]');

  let earlyResolve;
  const earlyTextPromise = new Promise((res) => { earlyResolve = res; });

  const result = (async () => {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        stream: true,
        temperature: 0.95,
        max_output_tokens: 300,
        input: [
          {
            role: 'system',
            content: [{
              type: 'input_text',
              text: systemPrompt,
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

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let deltaAccum = '';
    let fullOutputText = '';
    let earlyResolved = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        if (event.type === 'response.output_text.delta') {
          deltaAccum += event.delta?.text || '';
          if (!earlyResolved) {
            const match = deltaAccum.match(/"next_question_text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (match) {
              try {
                const earlyText = JSON.parse(`"${match[1]}"`);
                earlyResolve(earlyText);
                earlyResolved = true;
              } catch { /* malformed escape — wait for more */ }
            }
          }
        } else if (event.type === 'response.output_text.done') {
          fullOutputText = event.text || '';
        }
      }
    }

    if (!earlyResolved) earlyResolve(null);

    if (!fullOutputText) {
      const jsonMatch = deltaAccum.match(/\{[\s\S]*\}/);
      if (jsonMatch) fullOutputText = jsonMatch[0];
    }

    if (!fullOutputText) return null;
    const parsed = JSON.parse(fullOutputText);
    app.log.info({
      tag: '[LLM-OUT]',
      callSid: session.callSid,
      next_question_id: parsed.next_question_id,
      next_question_text: parsed.next_question_text?.slice(0, 120),
      extracted_keys: Object.keys(parsed.extracted || {}).filter(k => parsed.extracted[k]),
      done_reason: parsed.done_reason,
    }, '[LLM-OUT]');
    return parsed;
  })();

  result.catch(() => earlyResolve(null));
  return { earlyTextPromise, result };
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
  // calling_for — name of person being called about (third-party callers)
  const callingFor = String(extracted?.calling_for ?? '').trim();
  if (callingFor && callingFor !== session.collected.calling_for) {
    session.collected.calling_for = callingFor;
    updates.calling_for = callingFor;
  }
  // Store caller ID as a fallback for notifications/partial leads, but don't mark it
  // as "collected" — Ava must explicitly confirm the number with the caller before
  // it counts toward the done check.
  if (!session.collected.callback_number && session.fromPhone) {
    session.phoneFromCallerId = session.fromPhone;
  }
  return updates;
}

// ── SSML enrichment ───────────────────────────────────────────────────────────

function numberToWords(n) {
  if (n === 0) return 'zero';
  const ones = ['','one','two','three','four','five','six','seven','eight','nine',
                 'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen',
                 'seventeen','eighteen','nineteen'];
  const tens = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
  function below1000(n) {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n/10)] + (n%10 ? ' ' + ones[n%10] : '');
    return ones[Math.floor(n/100)] + ' hundred' + (n%100 ? ' ' + below1000(n%100) : '');
  }
  if (n < 1000) return below1000(n);
  if (n < 1000000) {
    const rem = n % 1000;
    return below1000(Math.floor(n/1000)) + ' thousand' + (rem ? ' ' + below1000(rem) : '');
  }
  return String(n);
}

function enrichForSpeech(text) {
  let s = String(text || '');
  let ssmlAdded = false;

  // Post-ack pause
  s = s.replace(
    /^(Got it|Of course|Sure|Absolutely|Certainly|I understand|Thank you|Understood|Perfect|Okay)\.\s+/i,
    (_, ack) => { ssmlAdded = true; return `${ack}.<break time='350ms'/> `; }
  );

  // Em-dash / en-dash mid-thought pause: "Oh — that's hard"
  s = s.replace(/ [—–] /g, () => { ssmlAdded = true; return `<break time='200ms'/>`; });

  // Ellipsis trailing-off: "And your name is...?"
  s = s.replace(/\.\.\./g, () => { ssmlAdded = true; return `<break time='280ms'/>`; });

  // Mid-sentence comma pause (only before lowercase words — clause-internal, not list-start)
  s = s.replace(/,(\s+)(?=[a-z])/g, (_, space) => {
    ssmlAdded = true;
    return `,<break time='80ms'/>${space}`;
  });

  // Phone number → spoken digits: "555-0142" → "five five five, zero one four two"
  const digitWords = ['zero','one','two','three','four','five','six','seven','eight','nine'];
  s = s.replace(/\b(\d{3})-(\d{3})-(\d{4})\b/g, (_, a, b, c) =>
    [...a, ...b, ...c].map(d => digitWords[+d]).join(' ')
  );
  s = s.replace(/\b(\d{3})-(\d{4})\b/g, (_, a, b) =>
    `${[...a].map(d => digitWords[+d]).join(' ')}, ${[...b].map(d => digitWords[+d]).join(' ')}`
  );

  // Dollar amounts: "$500" → "five hundred dollars"
  s = s.replace(/\$(\d{1,3}(?:,\d{3})*)/g, (_, numStr) => {
    const n = parseInt(numStr.replace(/,/g, ''), 10);
    return isNaN(n) ? _ : `${numberToWords(n)} dollars`;
  });

  // Wrap in <speak> only when SSML was injected
  if (ssmlAdded || /<break/.test(s)) s = `<speak>${s}</speak>`;
  return s;
}

// ── Speech composition (firm-aware) ──────────────────────────────────────────

function composeSpeakText({ session, bodyText, callSid, firmConfig, llmAck = '' }) {
  const trimmed = String(bodyText || '').trim();
  if (!trimmed) return '';

  if (!session.disclaimerShown) {
    session.disclaimerShown = true;
    if (session.callerType === 'returning' && session.knownName) {
      const firstName = session.knownName.split(/\s+/)[0];
      return getReturningGreeting(firstName, firmConfig);
    }
    const opening = firmConfig.opening || `Hi, this is ${firmConfig.ava_name || 'Ava'}, the attorney's assistant.`;
    // On first turn, append the caller type question so the caller knows what to say
    return session.callerType === null && trimmed ? `${opening} ${trimmed}` : opening;
  }

  // LLM provided its own acknowledgment — next_question_text already has it baked in,
  // so return it directly instead of prepending a redundant deterministic ack.
  if (llmAck) return enrichForSpeech(trimmed);

  const ack = getNextAck(callSid || session.callSid, firmConfig);
  return enrichForSpeech(`${ack} ${trimmed}`);
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

function gatherTwiml({ actionUrl, speakText, ttsKey, liveUrl = null, emptyCount = 0, hints = '' }) {
  const effectiveKey = ttsKey || holdKey;
  const speakerNode = effectiveKey
    ? `<Play>${xmlEscape(`${PUBLIC_BASE_URL}/api/tts?key=${encodeURIComponent(effectiveKey)}`)}</Play>`
    : liveUrl
      ? `<Play>${xmlEscape(liveUrl)}</Play>`
      : `<Say>${xmlEscape(speakText.replace(/<[^>]+>/g, ''))}</Say>`;
  const redirectUrl = addQueryParam(addQueryParam(actionUrl, 'empty', '1'), 'rc', Number(emptyCount) + 1);
  const hintsAttr = hints ? ` hints="${xmlEscape(hints)}"` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${xmlEscape(actionUrl)}" method="POST" speechTimeout="1" timeout="6" actionOnEmptyResult="true" bargeIn="true" enhanced="true" language="en-US" profanityFilter="false"${hintsAttr}>
    ${speakerNode}
  </Gather>
  <Redirect method="POST">${xmlEscape(redirectUrl)}</Redirect>
</Response>`;
}

async function voicemailTwiml({ firmId, callSid, fromPhone, firmConfig }) {
  const rawMsg = `Hi, you've reached ${firmConfig?.name || 'our office'}. Please leave your name, phone number, and a brief message after the tone and we'll get back to you shortly.`;
  const actionUrl = `${PUBLIC_BASE_URL}/voicemail-recording?firmId=${encodeURIComponent(firmId)}&callSid=${encodeURIComponent(callSid)}&from=${encodeURIComponent(fromPhone)}`;
  const ttsKey = await synthesizeToDisk(rawMsg).catch(() => null);
  const speakerNode = ttsKey
    ? `<Play>${xmlEscape(`${PUBLIC_BASE_URL}/api/tts?key=${encodeURIComponent(ttsKey)}`)}</Play>`
    : `<Say voice="alice">${xmlEscape(rawMsg)}</Say>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${speakerNode}
  <Record maxLength="60" transcribe="false" action="${xmlEscape(actionUrl)}" method="POST" playBeep="true"/>
  <Hangup/>
</Response>`;
}

function doneTwiml({ speakText, ttsKey, liveUrl = null, firmId = '', callSid = '' }) {
  const effectiveKey = ttsKey || holdKey;
  const speakerNode = effectiveKey
    ? `<Play>${xmlEscape(`${PUBLIC_BASE_URL}/api/tts?key=${encodeURIComponent(effectiveKey)}`)}</Play>`
    : liveUrl
      ? `<Play>${xmlEscape(liveUrl)}</Play>`
      : `<Say>${xmlEscape(speakText.replace(/<[^>]+>/g, ''))}</Say>`;

  // Grace period: keep the line open for 4 seconds after Ava's goodbye so the caller
  // can add anything before we hang up. Only applies to real call endings (not errors/rate-limits).
  if (firmId && callSid) {
    const graceUrl = `${PUBLIC_BASE_URL}/twiml-grace?callSid=${encodeURIComponent(callSid)}&firmId=${encodeURIComponent(firmId)}`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${xmlEscape(graceUrl)}" method="POST" speechTimeout="1" timeout="4" actionOnEmptyResult="true" bargeIn="false" enhanced="true" language="en-US" profanityFilter="false">
    ${speakerNode}
  </Gather>
  <Hangup/>
</Response>`;
  }

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

  const voiceSettingsKey = `${process.env.ELEVEN_STABILITY ?? '0.40'}|${process.env.ELEVEN_SIMILARITY ?? '0.75'}|${process.env.ELEVEN_STYLE ?? '0.35'}|${process.env.ELEVEN_SPEAKER_BOOST ?? 'true'}|${process.env.ELEVEN_SPEED ?? '1.10'}`;
  const key = sha1(`${ELEVENLABS_VOICE_ID}|${ELEVENLABS_MODEL_ID}|${voiceSettingsKey}|${safeText}`);
  const filePath = path.join(AUDIO_DIR, `${key}.mp3`);
  const already = await fs.readFile(filePath).catch(() => null);
  if (already) return key;

  try {
    const tFetchStart = Date.now();
    app.log.info({ key: key.slice(0, 8), textLen: safeText.length }, 'tts-fetch-start');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(500, TTS_TIMEOUT_MS));
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}/stream?optimize_streaming_latency=4&output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_API_KEY, Accept: 'audio/mpeg', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: safeText,
          model_id: ELEVENLABS_MODEL_ID,
          enable_ssml_parsing: true,
          voice_settings: {
            stability:        Number(process.env.ELEVEN_STABILITY      ?? 0.40),
            similarity_boost: Number(process.env.ELEVEN_SIMILARITY     ?? 0.75),
            style:            Number(process.env.ELEVEN_STYLE          ?? 0.35),
            use_speaker_boost: String(process.env.ELEVEN_SPEAKER_BOOST ?? 'true').toLowerCase() === 'true',
            speed:            Number(process.env.ELEVEN_SPEED          ?? 1.10),
          },
        }),
        signal: controller.signal,
      }
    ).finally(() => clearTimeout(timeout));

    app.log.info({ key: key.slice(0, 8), ok: resp.ok, status: resp.status, elapsedMs: Date.now() - tFetchStart }, 'tts-fetch-end');
    if (!resp.ok) {
      const errBody = await resp.text();
      console.error('tts-fetch-error', { status: resp.status, body: errBody });
      return null;
    }
    const audio = Buffer.from(await resp.arrayBuffer());
    console.log('tts-audio-bytes', audio.length);
    if (!audio.length) return null;
    await fs.writeFile(filePath, audio);
    console.log('tts-file-written', { key, bytes: audio.length, path: filePath });
    return key;
  } catch (err) {
    console.error('tts-fetch-exception', err.message);
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

  // Also prewarm ack+question combos — these are the exact strings spoken on turns 2+
  // e.g. "Got it. And the best number to reach you?" — not individually cached by the above
  for (const firm of firms) {
    const acks = firm.acknowledgments || [];
    const questions = Object.values(firm.question_overrides || {}).filter(Boolean);
    for (const ack of acks) {
      for (const q of questions) {
        allPhrases.add(`${ack} ${q}`);
      }
    }
  }

  const phrases = [...allPhrases];
  app.log.info(`Prewarming TTS cache for ${phrases.length} phrases across ${firms.length} firm(s)...`);
  const BATCH_SIZE = 8;
  let succeeded = 0;
  for (let i = 0; i < phrases.length; i += BATCH_SIZE) {
    const batch = phrases.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((p) => synthesizeToDisk(p)));
    succeeded += results.filter((r) => r.status === 'fulfilled' && r.value).length;
    if (i + BATCH_SIZE < phrases.length) await new Promise((r) => setTimeout(r, 500));
  }
  app.log.info(`TTS prewarm complete: ${succeeded}/${phrases.length} phrases cached`);
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
  if (!RESEND_API_KEY) { app.log.warn({ leadId: session.leadId }, 'sendEmailNotification: RESEND_API_KEY not set — skipping'); return; }
  if (!firmConfig.notification_email) { app.log.warn({ leadId: session.leadId, firmId: firmConfig.id }, 'sendEmailNotification: no notification_email on firm — skipping'); return; }
  app.log.info({ leadId: session.leadId, from: RESEND_FROM_EMAIL, to: firmConfig.notification_email }, 'sendEmailNotification: attempting send');

  const { full_name, callback_number, practice_area, case_summary } = session.collected;
  const name = full_name || 'Unknown Caller';
  const area = practice_area || 'General';
  const phone = callback_number || session.phoneFromCallerId || session.fromPhone;
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

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: [firmConfig.notification_email], subject: `New lead — ${name} (${area})`, html }),
    });
    if (!res.ok) { const e = await res.text().catch(() => ''); throw new Error(`Resend error ${res.status}: ${e}`); }
    const data = await res.json().catch(() => ({}));
    app.log.info({ id: data.id, leadId: session.leadId, to: firmConfig.notification_email }, 'email-sent');
  } catch (err) {
    app.log.error({ err: err.message, leadId: session.leadId, to: firmConfig.notification_email }, 'email-failed');
    throw err;
  }
}

async function sendPartialEmailNotification(session, firmConfig) {
  if (!RESEND_API_KEY) { app.log.warn({ leadId: session.leadId }, 'sendPartialEmailNotification: RESEND_API_KEY not set — skipping'); return; }
  if (!firmConfig.notification_email) { app.log.warn({ leadId: session.leadId, firmId: firmConfig.id }, 'sendPartialEmailNotification: no notification_email on firm — skipping'); return; }
  app.log.info({ leadId: session.leadId, from: RESEND_FROM_EMAIL, to: firmConfig.notification_email }, 'sendPartialEmailNotification: attempting send');
  const { full_name, callback_number, practice_area, case_summary, calling_for } = session.collected || {};
  const name = full_name || 'Unknown Caller';
  const phone = callback_number || session.phoneFromCallerId || session.fromPhone;
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
      ${calling_for ? infoRow('Calling For', calling_for) : ''}
      ${infoRow('Fields Captured', capturedFields)}
    </table>
    ${case_summary ? `<div style="margin-top:20px"><p style="margin:0 0 8px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8">Partial Summary</p><blockquote style="margin:0;padding:14px 16px;background:#fffbeb;border-left:4px solid #d97706;border-radius:0 8px 8px 0;font-size:14px;color:#1e293b;line-height:1.6">${case_summary}</blockquote></div>` : ''}
    ${ctaButton('View in Dashboard', dashUrl, '#d97706')}`;

  const html = emailShell({ headerColor: '#d97706', headerLabel: 'Partial Intake', headerTitle: `Partial Lead — ${name}`, body, firmName: firmConfig.name });

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: [firmConfig.notification_email], subject: `[Partial] Lead from ${name} (${area})`, html }),
    });
    if (!res.ok) { const e = await res.text().catch(() => ''); throw new Error(`Resend error ${res.status}: ${e}`); }
    const data = await res.json().catch(() => ({}));
    app.log.info({ id: data.id, leadId: session.leadId, to: firmConfig.notification_email }, 'email-sent');
  } catch (err) {
    app.log.error({ err: err.message, leadId: session.leadId, to: firmConfig.notification_email }, 'email-failed');
    throw err;
  }
}

async function sendVoicemailEmailNotification({ fromPhone, transcript, firmConfig, leadId }) {
  if (!RESEND_API_KEY) { app.log.warn({ leadId }, 'sendVoicemailEmailNotification: RESEND_API_KEY not set — skipping'); return; }
  if (!firmConfig.notification_email) { app.log.warn({ leadId, firmId: firmConfig.id }, 'sendVoicemailEmailNotification: no notification_email on firm — skipping'); return; }
  const dashUrl = `${WEB_BASE_URL}/leads/${leadId}`;
  try {
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
    const data = await res.json().catch(() => ({}));
    app.log.info({ id: data.id, leadId, to: firmConfig.notification_email }, 'email-sent');
  } catch (err) {
    app.log.error({ err: err.message, leadId, to: firmConfig.notification_email }, 'email-failed');
    throw err;
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

async function generateCallSummary(session) {
  if (!OPENAI_API_KEY || !session.transcript?.length) return;
  try {
    const transcript = session.transcript.map((e) => `${e.role}: ${e.text}`).join('\n');
    const collected = session.collected || {};
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 120,
        messages: [
          {
            role: 'system',
            content: 'You are summarizing a phone intake call for a law firm receptionist. Write 2-3 plain English sentences describing what happened: who called, what their situation is, and what was collected. Write in third person. Be specific — use the caller\'s actual words. Do not use bullet points or headers. Do not start with "The caller". Keep it under 80 words.',
          },
          {
            role: 'user',
            content: `Collected fields: ${JSON.stringify(collected)}\n\nTranscript:\n${transcript.slice(0, 3000)}`,
          },
        ],
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const summary = (data.choices?.[0]?.message?.content || '').trim();
    if (!summary) return;
    await patchLead(session.leadId, { call_summary: summary });
    app.log.info({ leadId: session.leadId }, 'call summary saved');
  } catch (err) {
    app.log.warn({ err: String(err), leadId: session.leadId }, 'call summary generation failed');
  }
}

async function generateDynamicFiller({ userText, lastQuestionText }) {
  if (!OPENAI_API_KEY) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        max_tokens: 20,
        messages: [
          {
            role: 'system',
            content:
              'You are a warm phone receptionist named Ava. The caller just finished speaking. ' +
              'Reply with ONLY a short (2 to 8 word) natural verbal filler that acknowledges what they said ' +
              'before you go look something up. Sound human — not robotic. ' +
              'Do NOT ask a question. Do NOT include quotes or punctuation beyond commas and periods. ' +
              'Do NOT use "Absolutely", "Certainly", "Of course", "Sure thing", or "Great". ' +
              'Examples: "Oh, one moment.", "Got it, just a sec.", "Okay, hold on.", "Mm, one moment.", "Sure, give me just a second."',
          },
          {
            role: 'user',
            content:
              `Ava asked: ${lastQuestionText || '(call just started)'}\n` +
              `Caller said: ${userText.slice(0, 300)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(DYNAMIC_FILLER_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
    if (!text || text.length > 80 || text.length < 3) return null;
    return text;
  } catch {
    return null; // AbortError (timeout) or network error → fall back to static
  }
}

function fireNotifications(session, firmConfig) {
  app.log.info(
    { leadId: session.leadId, done: session.done, hasResendKey: !!RESEND_API_KEY, notificationEmail: firmConfig?.notification_email || '' },
    'fireNotifications called',
  );
  if (!session.done) return;
  sendEmailNotification(session, firmConfig)
    .catch(() => new Promise((r) => setTimeout(r, 3000))
      .then(() => sendEmailNotification(session, firmConfig))
      .catch((err) => app.log.error({ err: String(err), leadId: session.leadId }, 'email notification failed after retry')));
  sendSmsNotification(session, firmConfig)
    .catch((err) => app.log.warn({ err: String(err), leadId: session.leadId }, 'sms notification failed'));
  // Build a minimal lead object for the webhook payload
  const lead = { id: session.leadId, firmId: session.firmId, fromPhone: session.fromPhone, status: 'ready_for_review', ...session.collected };
  fireWebhooks(lead, session.firmId, firmConfig);
  scoreCallQuality(session); // fire-and-forget
  generateCallSummary(session); // fire-and-forget
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

// ── Returning caller lookup ───────────────────────────────────────────────────

async function lookupCallerHistory(phone, firmId) {
  try {
    const priorLeads = await getLeadsByPhone(phone, firmId);
    if (!priorLeads.length) return { isReturning: false, priorLeads: [] };
    const lastLead = priorLeads[0];
    const capturedFields = {
      full_name:       lastLead.full_name       || '',
      callback_number: lastLead.callback_number || '',
      practice_area:   lastLead.practice_area   || '',
    };
    return { isReturning: true, priorLeads, lastCallDate: lastLead.updatedAt, capturedFields };
  } catch {
    return { isReturning: false, priorLeads: [] };
  }
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

  // Early exit detection — caller wants to end the call before intake is complete
  if (callerText && detectEarlyExit(callerText)) {
    session.done = true;
    sessionAckIndex.delete(callSid);
    const exitText = getEarlyExitPhrase(firmConfig);
    appendTranscript(session, 'assistant', exitText);
    sessions[callSid] = session;
    const ttsKey = await synthesizeToDisk(exitText).catch(() => null);
    saveSessions(sessions).catch((err) => app.log.warn({ err: String(err), callSid }, 'early-exit saveSessions failed'));
    persistSessionArtifacts(session, { assistantText: exitText, callerText, done: true }).catch((err) => app.log.warn({ err: String(err), callSid }, 'early-exit persistArtifacts failed'));
    return { firmConfig, session, payload: { speakText: exitText, ttsKey, done: true, nextField: null, timings: {} } };
  }

  // Returning caller check — on first turn only (before caller type question is asked)
  if (!callerText && session.callerType === null) {
    const history = await lookupCallerHistory(normalizedPhone, firmConfig.id);
    if (history.isReturning) {
      session.callerType = 'returning';
      // Pre-populate captured fields so Ava doesn't re-ask
      for (const [k, v] of Object.entries(history.capturedFields)) {
        if (v && !session.collected[k]) session.collected[k] = v;
      }
      if (history.capturedFields.full_name) {
        session.knownName = history.capturedFields.full_name;
      }
      app.log.info({ callSid, knownName: session.knownName, lastCallDate: history.lastCallDate }, 'returning-caller-detected');
    } else {
      // Unknown phone — default to 'new' to skip the "Are you a new or existing client?" gate.
      // detectCallerType() can still override to 'returning' mid-call if the caller self-identifies.
      session.callerType = 'new';
    }
  }

  const deterministicExtracted = extractAllFieldsFromLongResponse(callerText);

  // If callerType is already known from a prior turn, use effectiveConfig for the LLM
  // so it only suggests questions for the fields actually required in this caller's path.
  const llmConfig = getEffectiveConfig(session, firmConfig);

  // Fire OpenAI immediately (parallel with TTS prefetch below)
  const tOpenAiStart = Date.now();
  let llmPromise = null;
  let earlyTextPromise = Promise.resolve(null);
  let earlyTtsPromise = null;
  if (callerText && OPENAI_API_KEY) {
    const llmStream = callOpenAiForNextStep({ firmConfig: llmConfig, session, userText: callerText });
    llmPromise = llmStream.result.catch((err) => {
      app.log.warn({ err: String(err), callSid }, 'OpenAI failed; using deterministic fallback');
      return null;
    });
    earlyTextPromise = llmStream.earlyTextPromise;
  }

  // Speculatively start TTS on the most likely next phrase while OpenAI is thinking.
  // buildDeterministicQuestion is read-only (no side effects) — safe to call early.
  // This result is used ONLY for the TTS prefetch; session state is NOT updated here.
  const speculativeDecision = buildDeterministicQuestion(session, firmConfig);
  let speculativeText = '';
  let ttsPrefetch = null;
  if (!speculativeDecision.done && speculativeDecision.nextQuestionText) {
    speculativeText = session.disclaimerShown
      ? speculativeDecision.nextQuestionText
      : (firmConfig.opening || `Hi, this is ${firmConfig.ava_name || 'Ava'}, the attorney's assistant.`);
    ttsPrefetch = synthesizeToDisk(speculativeText).catch(() => null);
  }

  // Kick off TTS as soon as early text arrives (before full OpenAI response is done)
  earlyTextPromise.then((earlyText) => {
    if (earlyText && earlyText !== speculativeText) {
      earlyTtsPromise = synthesizeToDisk(earlyText).catch(() => null);
    }
  });

  const llmRaw = llmPromise ? await llmPromise : null;
  const llm = validateLlmResponse(llmRaw, session, app);
  const tAfterOpenAi = Date.now();
  if (llmPromise) app.log.info({ callSid, elapsedMs: tAfterOpenAi - tOpenAiStart }, 'openai-returned');
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
    // The urgency statement ("I was in a car accident and I'm scared") may have been
    // auto-extracted as case_summary by extractStructuredDeterministic (≥40 chars, ≥4 words).
    // That's NOT a real case summary — it's just the distress signal.
    // Clear it so Ava explicitly asks for a case summary on a later turn instead of jumping to done.
    if (!session.askedQuestionIds.includes('case_summary')) {
      delete session.collected.case_summary;
    }
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
      // 5.2 — field-repeat guard: skip if already collected
      if (session.collected[nextId] && String(session.collected[nextId]).trim()) {
        // already collected — let deterministic fallback pick the next missing field
      } else {
        nextDecision = { done: false, nextField: missing[0], nextQuestionId: nextId, nextQuestionText: nextText };
      }
    }
  }

  // Require both GPT agreement and core fields before allowing hangup.
  // If LLM is available and returned a non-"done" next_question_id, keep going
  // even if fields appear collected — GPT may know the caller isn't actually done.
  // The question cap remains a hard ceiling regardless.
  const llmWantsContinue = llm && String(llm.next_question_id || '').trim() !== 'done';
  // callback_number must be explicitly collected (not just inferred from caller ID)
  // to count as present for the done check.
  const allCorePresent = ['full_name', 'case_summary'].every(
      (f) => String(session.collected[f] || '').trim().length >= 2,
    ) && String(session.collected.callback_number || '').trim().length >= 2;
  // Hard cap: allow up to 4 extra turns if core fields aren't collected yet.
  // This prevents hanging up on a caller who never gave their name or number.
  const hardCap = reachedQuestionCap && (allCorePresent || session.turnCount >= (maxQ + 4));
  const done = hardCap
    || (allCorePresent && !llmWantsContinue && (allCollected || nextDecision.done));

  let speakText = effectiveConfig.closing || DEFAULT_FIRM_CONFIG.closing;
  let nextField = null;
  // llmAck is no longer a separate field — acknowledgment is baked into next_question_text
  const llmAck = '';

  if (!done) {
    session.turnCount += 1;
    session.lastQuestionId = nextDecision.nextQuestionId;
    session.lastQuestionText = nextDecision.nextQuestionText;
    session.askedQuestionIds.push(nextDecision.nextQuestionId);
    nextField = nextDecision.nextField;

    // LLM's next_question_text has the emotional ack baked in per system prompt — use it directly.
    // Fall back to deterministic question only if LLM didn't return one.
    const llmQuestionText = String(llm?.next_question_text || '').trim();
    let questionBody = llmQuestionText || nextDecision.nextQuestionText;

    // Apply clarifying note only on the deterministic fallback path
    if (!llmQuestionText) {
      const clarifyNote = String(llm?.clarifying_note || '').trim();
      if (clarifyNote) {
        const capped = clarifyNote.split(/\s+/).filter(Boolean).slice(0, 20).join(' ');
        questionBody = `${capped} ${questionBody}`;
      }
    }

    // If the LLM didn't return a separate acknowledgment but baked one into next_question_text
    // (as the system prompt allows), treat it as having an ack to prevent composeSpeakText
    // from prepending a redundant deterministic ack.
    // If the LLM returned any text, trust it — the system prompt requires it to bake in an ack.
    // Never prepend a deterministic ack on top of LLM-generated speech.
    const effectiveLlmAck = llmAck || (llmQuestionText ? '_baked_in_' : '');
    speakText = composeSpeakText({ session, bodyText: questionBody, callSid, firmConfig: effectiveConfig, llmAck: effectiveLlmAck });
    app.log.info({ llmAck, effectiveLlmAck, usedLlmText: !!llmQuestionText, questionBody, speakText }, 'ava-speaks');

    // Urgency: only apply empathetic fallback if LLM didn't already provide an acknowledgment.
    // Uses effectiveLlmAck (not llmAck) so baked-in acks in next_question_text are respected.
    if (session.isUrgent && !session.urgencySpoken) {
      session.urgencySpoken = true;
      if (!effectiveLlmAck) {
        const opener = getUrgencyOpener(firmConfig, session);
        speakText = `${opener} ${nextDecision.nextQuestionText}`;
      }
    }
  } else {
    session.done = true;
    session.lastQuestionId = '';
    session.lastQuestionText = '';
    speakText = effectiveConfig.closing || DEFAULT_FIRM_CONFIG.closing;
    // Urgency on the final turn: only override if LLM didn't already handle emotional acknowledgment
    if (session.isUrgent && !session.urgencySpoken) {
      session.urgencySpoken = true;
      if (!llmAck) {
        const opener = getUrgencyOpener(firmConfig, session);
        speakText = `${opener} ${speakText}`;
      }
    }
    sessionAckIndex.delete(callSid);
    fillerLastIdxMap.delete(callSid);
  }
  const tAfterCompose = Date.now();

  // Log any time the speculative TTS phrase differed from what was actually spoken,
  // so we can see question-skip or phrasing-change patterns in the logs.
  if (ttsPrefetch && speakText !== speculativeText) {
    app.log.info(
      { callSid, speculativeText, speakText },
      'tts-prefetch miss — speculative phrase differed from final (prefetch cached for future use)',
    );
  }

  // C2 — guard against empty speakText
  if (!speakText || !speakText.trim()) {
    app.log.error({ callSid, done, nextDecision }, 'speakText was empty — using closing as fallback');
    speakText = effectiveConfig.closing || DEFAULT_FIRM_CONFIG.closing;
  }

  appendTranscript(session, 'assistant', speakText);
  session.updatedAt = nowIso();
  sessions[callSid] = session;

  // Resolve TTS with a hard deadline: we've already spent time waiting for OpenAI,
  // so cap the additional ElevenLabs wait to TTS_BUDGET_MS. If it's not ready in
  // time, fall back to Twilio <Say> and let the file cache in the background.
  const TTS_BUDGET_MS = Number(process.env.TTS_BUDGET_MS ?? 15000);
  const ttsDeadline = new Promise((r) => setTimeout(() => r(null), TTS_BUDGET_MS));
  const tTtsStart = Date.now();
  let ttsKey;
  if (speakText === speculativeText && ttsPrefetch) {
    // Speculative hit — audio is likely already cached; race just in case
    ttsKey = await Promise.race([ttsPrefetch, ttsDeadline]);
    app.log.info({ callSid, hit: !!ttsKey, elapsedMs: Date.now() - tTtsStart, totalMs: Date.now() - tOpenAiStart }, 'tts-resolved (speculative)');
    if (!ttsKey) app.log.info({ callSid }, 'tts-speculative-hit but deadline exceeded, using <Say>');
  } else if (earlyTtsPromise && speakText === (await earlyTextPromise)) {
    // Early-stream hit — TTS has been running since next_question_text arrived in stream
    ttsKey = await Promise.race([earlyTtsPromise, ttsDeadline]);
    app.log.info({ callSid, hit: !!ttsKey, elapsedMs: Date.now() - tTtsStart, totalMs: Date.now() - tOpenAiStart }, 'tts-resolved (early-stream)');
    if (!ttsKey) app.log.info({ callSid, speakText: speakText.slice(0, 60) }, 'tts-early-stream deadline exceeded, using <Say>');
  } else {
    // Mismatch — start fresh synth; cache the speculative result quietly
    if (ttsPrefetch) ttsPrefetch.catch(() => {});
    const freshSynth = synthesizeToDisk(speakText);
    ttsKey = await Promise.race([freshSynth, ttsDeadline]);
    app.log.info({ callSid, hit: !!ttsKey, elapsedMs: Date.now() - tTtsStart, totalMs: Date.now() - tOpenAiStart }, 'tts-resolved (fresh)');
    if (!ttsKey) {
      app.log.info({ callSid, speakText: speakText.slice(0, 60) }, 'tts-miss deadline exceeded, using <Say>');
      freshSynth.catch(() => {}); // keep caching for future turns
    }
  }
  const tAfterTts = Date.now();

  // Fire-and-forget — the TwiML response doesn't depend on write completion
  saveSessions(sessions).catch((err) => app.log.warn({ err: String(err), callSid }, 'saveSessions failed'));
  persistSessionArtifacts(session, { assistantText: speakText, callerText, done: session.done })
    .then(() => { if (session.done) app.log.info({ callSid, leadId: session.leadId }, 'persistArtifacts OK — lead saved to DB'); })
    .catch((err) => app.log.error({ err: String(err), callSid, leadId: session.leadId }, 'persistArtifacts FAILED — lead not saved'));
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
      timings: { t1: tOpenAiStart, t2: tAfterOpenAi, t3: tAfterCompose, t4: tAfterTts },
    },
  };
}

function applyRepromptText(session, firmConfig) {
  const maxReprompts = firmConfig?.max_reprompts || 2;
  if (session.repromptCount >= maxReprompts) {
    session.done = true;
    const closing = firmConfig?.closing || DEFAULT_FIRM_CONFIG.closing;
    return getRepromptClosePhrase(firmConfig || DEFAULT_FIRM_CONFIG, closing);
  }
  const base = session.lastQuestionText || getQuestionText('full_name', firmConfig || DEFAULT_FIRM_CONFIG);
  const phrases = getRepromptPhrases(firmConfig || DEFAULT_FIRM_CONFIG);
  const template = phrases[session.repromptCount] || phrases[phrases.length - 1] || `I'm still here. ${base}`;
  return template.replace('{QUESTION}', base);
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

// POST /test-email — sends a dummy lead email to verify Resend is working
app.post('/test-email', async (req, reply) => {
  const to = String(req.body?.to || req.query?.to || '').trim();
  if (!to) return reply.code(400).send({ error: 'Missing ?to= query param or body.to' });
  if (!RESEND_API_KEY) return reply.code(503).send({ error: 'RESEND_API_KEY not set' });

  const fromWarning = RESEND_FROM_EMAIL.endsWith('@resend.dev')
    ? `WARNING: using Resend sandbox sender (${RESEND_FROM_EMAIL}) — emails can only be delivered to the Resend account owner's address. Set RESEND_FROM_EMAIL to a verified sender domain for production.`
    : null;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [to],
        subject: '[Ava test] Email delivery check',
        html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1e293b">
          <h2 style="margin:0 0 12px">Ava email test ✓</h2>
          <p>If you're reading this, Resend is configured correctly.</p>
          <ul>
            <li><strong>From:</strong> ${RESEND_FROM_EMAIL}</li>
            <li><strong>To:</strong> ${to}</li>
            <li><strong>Time:</strong> ${new Date().toISOString()}</li>
          </ul>
        </div>`,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Resend error ${res.status}: ${errText}`);
    }
    const data = await res.json().catch(() => ({}));
    app.log.info({ id: data.id, to, from: RESEND_FROM_EMAIL }, 'test-email sent OK');
    return reply.send({ ok: true, id: data.id, from: RESEND_FROM_EMAIL, to, warning: fromWarning });
  } catch (err) {
    app.log.error({ err: err.message, to }, 'test-email failed');
    return reply.code(500).send({ ok: false, error: err.message, from: RESEND_FROM_EMAIL, to });
  }
});

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

app.get('/api/firms/:id/phone/search', async (req, reply) => {
  const id = String(req.params.id || '').trim();
  const firm = await loadFirmConfig(id);
  if (firm.id !== id) return reply.code(404).send({ error: 'Firm not found' });

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
    return reply.code(400).send({ error: 'Twilio credentials not configured' });

  const areaCode = String(req.query?.areaCode || '').replace(/\D/g, '').slice(0, 3);
  if (areaCode.length !== 3)
    return reply.code(400).send({ error: 'areaCode must be a 3-digit NXX code' });

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const qs = new URLSearchParams({ AreaCode: areaCode, VoiceEnabled: 'true', Limit: '10' });
  const resp = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/AvailablePhoneNumbers/US/Local.json?${qs}`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  if (!resp.ok) {
    const body = await resp.text();
    app.log.warn({ firmId: id, areaCode, status: resp.status, body }, 'Twilio number search failed');
    return reply.code(502).send({ error: 'Twilio number search failed' });
  }
  const data = await resp.json();
  return {
    data: (data.available_phone_numbers || []).map((n) => ({
      phoneNumber: n.phone_number,
      friendlyName: n.friendly_name,
    })),
  };
});

app.post('/api/firms/:id/phone/purchase', async (req, reply) => {
  const id = String(req.params.id || '').trim();
  const firm = await loadFirmConfig(id);
  if (firm.id !== id) return reply.code(404).send({ error: 'Firm not found' });

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
    return reply.code(400).send({ error: 'Twilio credentials not configured' });

  const phoneNumber = String(req.body?.phoneNumber || '').trim();
  if (!phoneNumber || !phoneNumber.startsWith('+'))
    return reply.code(400).send({ error: 'phoneNumber must be E.164 (e.g. +14155551234)' });

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const twilioBase = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}`;

  // Step 1 — Purchase
  const purchaseResp = await fetch(`${twilioBase}/IncomingPhoneNumbers.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      PhoneNumber: phoneNumber,
      FriendlyName: `Ava — ${firm.name || id}`,
    }).toString(),
  });
  if (!purchaseResp.ok) {
    const body = await purchaseResp.text();
    app.log.warn({ firmId: id, phoneNumber, status: purchaseResp.status, body }, 'Twilio purchase failed');
    return reply.code(502).send({ error: 'Failed to purchase number' });
  }
  const purchased = await purchaseResp.json();

  // Step 2 — Configure VoiceUrl webhook
  const voiceUrl = `${PUBLIC_BASE_URL}/twiml?firmId=${encodeURIComponent(id)}`;
  const configResp = await fetch(`${twilioBase}/IncomingPhoneNumbers/${purchased.sid}.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ VoiceUrl: voiceUrl, VoiceMethod: 'POST' }).toString(),
  });
  if (!configResp.ok) {
    // Number purchased but webhook config failed — save number anyway, log for manual fix
    app.log.warn({ firmId: id, sid: purchased.sid }, 'Twilio webhook config failed after purchase');
  }

  // Step 3 — Persist to firm config
  await saveFirmConfig(id, { ...firm, twilio_phone: phoneNumber });
  app.log.info({ firmId: id, phoneNumber, sid: purchased.sid, voiceUrl }, 'Phone number provisioned');

  return { data: { phoneNumber, sid: purchased.sid, voiceUrl } };
});

app.get('/api/demo-number', async () => {
  return { number: process.env.DEMO_PHONE_NUMBER || null };
});

app.get('/api/calls', async (req, reply) => {
  const firmId = String(req.query?.firmId || '').trim();
  const isAdmin = ADMIN_API_KEY && req.headers?.['x-admin-key'] === ADMIN_API_KEY;
  if (!firmId && !isAdmin) return reply.code(400).send({ error: 'firmId required' });
  const calls = await loadCalls(firmId || undefined);
  calls.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { data: calls.slice(0, 100) };
});

app.get('/api/calls/:id/transcript', async (req, reply) => {
  const firmId = String(req.query?.firmId || '').trim();
  if (!firmId) return reply.code(400).send({ error: 'firmId required' });
  const callId = req.params.id;
  const call = await getCallById(callId);
  if (!call) return reply.code(404).send({ error: 'Call not found' });
  if (call.firmId !== firmId) return reply.code(404).send({ error: 'Call not found' });
  return { data: call.transcript };
});

app.get('/api/leads', async (req, reply) => {
  const firmId = String(req.query?.firmId || '').trim();
  const isAdmin = ADMIN_API_KEY && req.headers?.['x-admin-key'] === ADMIN_API_KEY;
  if (!firmId && !isAdmin) return reply.code(400).send({ error: 'firmId required' });
  const leads = await loadLeads(firmId || undefined);
  leads.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { data: leads };
});

app.get('/api/leads/:id', async (req, reply) => {
  const firmId = String(req.query?.firmId || '').trim();
  const leads = await loadLeads(firmId || undefined);
  const lead = leads.find((x) => x.id === req.params.id);
  if (!lead) return reply.code(404).send({ error: 'Lead not found' });
  return { data: lead };
});

app.patch('/api/leads/:id', async (req, reply) => {
  const { id } = req.params;
  const firmId = String(req.body?.firmId || '').trim();
  if (firmId) {
    const lead = await getLeadById(id);
    if (!lead) return reply.code(404).send({ error: 'Lead not found' });
    if (lead.firmId !== firmId) return reply.code(403).send({ error: 'Forbidden' });
  }
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

// GET /tts-live — streams ElevenLabs audio directly to Twilio in real time.
// Cache hit: serves from disk immediately. Cache miss: proxies ElevenLabs stream
// byte-by-byte so Twilio starts playing within ~300ms, and caches to disk in parallel.
app.get('/tts-live', async (req, reply) => {
  const text = String(req.query?.text || '').trim();
  if (!text) return reply.code(400).send('text required');
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return reply.code(503).send('TTS unavailable');

  const safeText = truncateForSpeech(text, MAX_TTS_CHARS);
  const voiceSettingsKey = `${process.env.ELEVEN_STABILITY ?? '0.40'}|${process.env.ELEVEN_SIMILARITY ?? '0.75'}|${process.env.ELEVEN_STYLE ?? '0.35'}|${process.env.ELEVEN_SPEAKER_BOOST ?? 'true'}|${process.env.ELEVEN_SPEED ?? '1.10'}`;
  const key = sha1(`${ELEVENLABS_VOICE_ID}|${ELEVENLABS_MODEL_ID}|${voiceSettingsKey}|${safeText}`);
  const filePath = path.join(AUDIO_DIR, `${key}.mp3`);

  // Cache hit — serve from disk immediately
  const cached = await fs.readFile(filePath).catch(() => null);
  if (cached) {
    app.log.info({ key: key.slice(0, 8), bytes: cached.length }, 'tts-live cache-hit');
    reply.header('Content-Type', 'audio/mpeg');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(cached);
  }

  // Cache miss — stream directly from ElevenLabs, cache to disk in parallel
  const tStart = Date.now();
  app.log.info({ key: key.slice(0, 8), textLen: safeText.length }, 'tts-live stream-start');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(500, TTS_TIMEOUT_MS));

  let resp;
  try {
    resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}/stream?optimize_streaming_latency=4&output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_API_KEY, Accept: 'audio/mpeg', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: safeText,
          model_id: ELEVENLABS_MODEL_ID,
          enable_ssml_parsing: true,
          voice_settings: {
            stability:        Number(process.env.ELEVEN_STABILITY      ?? 0.40),
            similarity_boost: Number(process.env.ELEVEN_SIMILARITY     ?? 0.75),
            style:            Number(process.env.ELEVEN_STYLE          ?? 0.35),
            use_speaker_boost: String(process.env.ELEVEN_SPEAKER_BOOST ?? 'true').toLowerCase() === 'true',
            speed:            Number(process.env.ELEVEN_SPEED          ?? 1.10),
          },
        }),
        signal: controller.signal,
      }
    ).finally(() => clearTimeout(timeout));
  } catch (err) {
    console.error('tts-live fetch-exception', err.message);
    return reply.code(502).send('TTS fetch failed');
  }

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    console.error('tts-live fetch-error', { status: resp.status, body: errBody });
    return reply.code(502).send('TTS unavailable');
  }

  app.log.info({ key: key.slice(0, 8), firstByteMs: Date.now() - tStart }, 'tts-live first-bytes');

  // Pipe ElevenLabs stream → Twilio via PassThrough, collect chunks for disk cache
  const passthrough = new PassThrough();
  const chunks = [];
  const nodeStream = Readable.fromWeb(resp.body);

  nodeStream.on('data', (chunk) => {
    chunks.push(chunk);
    passthrough.write(chunk);
  });
  nodeStream.on('end', () => {
    passthrough.end();
    const audio = Buffer.concat(chunks);
    app.log.info({ key: key.slice(0, 8), bytes: audio.length, elapsedMs: Date.now() - tStart }, 'tts-live stream-complete');
    if (audio.length) {
      fs.writeFile(filePath, audio)
        .then(() => console.log('tts-live-cached', { key: key.slice(0, 8), bytes: audio.length }))
        .catch(() => {});
    }
  });
  nodeStream.on('error', (err) => {
    console.error('tts-live stream-error', err.message);
    passthrough.destroy(err);
  });

  reply.header('Content-Type', 'audio/mpeg');
  reply.header('Transfer-Encoding', 'chunked');
  reply.header('Cache-Control', 'no-store');
  return reply.send(passthrough);
});

app.post('/twiml', async (req, reply) => {
  const tTwimlStart = Date.now();
  const callSid = String(req.body?.CallSid || '').trim();
  const fromPhone = normalizePhone(req.body?.From);
  const userText = String(req.body?.SpeechResult || '').trim();
  const t0 = Date.now();
  const firmId = String(req.body?.firmId || req.query?.firmId || 'firm_default').trim();
  const isEmptyRedirect = String(req.query?.empty || '') === '1';

  app.log.info({ type: 'incoming-payload', callSid, userText: userText.slice(0, 200), firmId }, 'Incoming payload');

  if (!callSid) {
    reply.header('Content-Type', 'text/xml');
    return reply.send(doneTwiml({ speakText: 'Unable to continue this call right now.', ttsKey: null }));
  }

  // Rate limiting: per-IP (10 req/min) and per-firmId (100 calls/day)
  const clientIp = req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(`ip:${clientIp}`, 10, 60_000)) {
    reply.header('Content-Type', 'text/xml');
    app.log.warn({ clientIp, firmId }, 'rate limit hit (IP)');
    return reply.send(doneTwiml({ speakText: RATE_LIMIT_MESSAGES[Math.floor(Math.random() * RATE_LIMIT_MESSAGES.length)], ttsKey: null }));
  }
  if (!checkRateLimit(`firm:${firmId}`, 100, 86_400_000)) {
    reply.header('Content-Type', 'text/xml');
    app.log.warn({ firmId }, 'rate limit hit (firm)');
    return reply.send(doneTwiml({ speakText: RATE_LIMIT_MESSAGES[Math.floor(Math.random() * RATE_LIMIT_MESSAGES.length)], ttsKey: null }));
  }

  // Answering machine / voicemail detection
  const answeredBy = String(req.body?.AnsweredBy || '').trim();
  if (answeredBy === 'machine_start' || answeredBy === 'fax') {
    const vmConfig = await loadFirmConfig(firmId);
    reply.header('Content-Type', 'text/xml');
    return reply.send(await voicemailTwiml({ firmId, callSid, fromPhone, firmConfig: vmConfig }));
  }

  try {
    const firmConfig = await loadFirmConfig(firmId);

    // ── Trial / suspension enforcement ───────────────────────────────────────
    if (firmConfig.status === 'suspended') {
      reply.header('Content-Type', 'text/xml');
      return reply.send(`<Response><Say>${xmlEscape(SUSPENDED_MESSAGE)}</Say><Hangup/></Response>`);
    }
    if (firmConfig.status === 'trial' && firmConfig.trial_ends_at && new Date() > new Date(firmConfig.trial_ends_at)) {
      // Auto-suspend expired trial
      await saveFirmConfig(firmId, { ...firmConfig, status: 'suspended' });
      reply.header('Content-Type', 'text/xml');
      return reply.send(`<Response><Say>${xmlEscape(TRIAL_EXPIRED_MESSAGE)}</Say><Hangup/></Response>`);
    }
    // Trial warning: check on each call if within 24h of expiry and warning not yet sent
    if (firmConfig.status === 'trial' && firmConfig.trial_ends_at && !firmConfig.trial_warning_sent) {
      const msUntilExpiry = new Date(firmConfig.trial_ends_at).getTime() - Date.now();
      if (msUntilExpiry > 0 && msUntilExpiry < 24 * 60 * 60 * 1000) {
        saveFirmConfig(firmId, { ...firmConfig, trial_warning_sent: true })
          .catch((err) => app.log.warn({ err: String(err), firmId }, 'trial warning save failed'));
        if (firmConfig.notification_email && RESEND_API_KEY) {
          const trialEnd = new Date(firmConfig.trial_ends_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: RESEND_FROM_EMAIL,
              to: firmConfig.notification_email,
              subject: 'Your Ava trial ends tomorrow',
              html: `<p>Hi,</p><p>Your Ava free trial ends on <strong>${trialEnd}</strong>. To keep your calls answered without interruption, <a href="${WEB_BASE_URL}/settings">upgrade your plan</a>.</p>`,
            }),
          }).catch((err) => app.log.warn({ err: String(err), firmId }, 'trial warning email failed'));
        }
      }
    }

    const sessions = await loadSessions();
    let session = sessions[callSid];
    if (!session) {
      session = createSession({ callSid, firmId, fromPhone, firmConfig });
      sessions[callSid] = session;
      await saveSessions(sessions);
      // Register statusCallback and enable recording on the live call
      if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
        const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
        fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            StatusCallback: `${PUBLIC_BASE_URL}/call-status`,
            StatusCallbackMethod: 'POST',
            Record: 'record-from-answer-dual',
            RecordingStatusCallback: `${PUBLIC_BASE_URL}/recording-status`,
            RecordingStatusCallbackMethod: 'POST',
          }).toString(),
        }).catch((err) => app.log.warn({ err: String(err), callSid }, 'statusCallback/recording registration failed'));
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
      // C3 — duplicate controller guard: if a controller is already pending, replay filler + redirect
      if (pendingResponses.has(callSid)) {
        app.log.warn({ callSid }, '/twiml: duplicate request while controller pending — replaying filler');
        const lastFillerIdxDup = fillerLastIdxMap.get(callSid) ?? -1;
        let fillerIdxDup;
        do { fillerIdxDup = Math.floor(Math.random() * FILLER_PHRASES.length); }
        while (FILLER_PHRASES.length > 1 && fillerIdxDup === lastFillerIdxDup);
        const fillerKeyDup = fillerKeys[fillerIdxDup];
        const fillerAudioUrlDup = fillerKeyDup
          ? `${PUBLIC_BASE_URL}/api/tts?key=${encodeURIComponent(fillerKeyDup)}`
          : `${PUBLIC_BASE_URL}/tts-live?text=${encodeURIComponent(FILLER_PHRASES[fillerIdxDup])}&firmId=${encodeURIComponent(firmId)}`;
        const resultUrlDup = `${PUBLIC_BASE_URL}/twiml-result?callSid=${encodeURIComponent(callSid)}&firmId=${encodeURIComponent(firmId)}`;
        reply.header('Content-Type', 'text/xml');
        return reply.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${xmlEscape(fillerAudioUrlDup)}</Play>
  <Redirect method="POST">${xmlEscape(resultUrlDup)}</Redirect>
</Response>`);
      }

      // Normal turn — start processing in background, play filler immediately while OpenAI runs
      const processingPromise = runNextStepController({ firmId, callSid, fromPhone, userText });
      pendingResponses.set(callSid, { promise: processingPromise, t0 });

      // Static filler index computed first (anti-repeat state maintained regardless of dynamic path)
      const lastFillerIdx = fillerLastIdxMap.get(callSid) ?? -1;
      let fillerIdx;
      do { fillerIdx = Math.floor(Math.random() * FILLER_PHRASES.length); }
      while (FILLER_PHRASES.length > 1 && fillerIdx === lastFillerIdx);
      fillerLastIdxMap.set(callSid, fillerIdx);
      const fillerKey = fillerKeys[fillerIdx];
      const staticFillerAudioUrl = fillerKey
        ? `${PUBLIC_BASE_URL}/api/tts?key=${encodeURIComponent(fillerKey)}`
        : `${PUBLIC_BASE_URL}/tts-live?text=${encodeURIComponent(FILLER_PHRASES[fillerIdx])}&firmId=${encodeURIComponent(firmId)}`;

      // Race GPT-generated contextual filler against timeout; null → use static
      const dynamicText = await generateDynamicFiller({
        userText,
        lastQuestionText: session.lastQuestionText || '',
      });
      const fillerAudioUrl = dynamicText
        ? `${PUBLIC_BASE_URL}/tts-live?text=${encodeURIComponent(dynamicText)}&firmId=${encodeURIComponent(firmId)}`
        : staticFillerAudioUrl;

      const resultUrl = `${PUBLIC_BASE_URL}/twiml-result?callSid=${encodeURIComponent(callSid)}&firmId=${encodeURIComponent(firmId)}`;

      app.log.info({ callSid, fillerIdx, fillerCached: !!fillerKey, dynamicFiller: dynamicText ?? null }, 'filler-sent');
      reply.header('Content-Type', 'text/xml');
      return reply.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${xmlEscape(fillerAudioUrl)}</Play>
  <Redirect method="POST">${xmlEscape(resultUrl)}</Redirect>
</Response>`);
    }

    // Build a live-stream URL for cache misses — Twilio fetches it and gets audio immediately
    const liveUrl = !ttsKey
      ? `${PUBLIC_BASE_URL}/tts-live?text=${encodeURIComponent(speakText)}&firmId=${encodeURIComponent(firmId)}`
      : null;

    reply.header('Content-Type', 'text/xml');
    app.log.info({ callSid, ttsHit: !!ttsKey, liveStream: !!liveUrl, totalMs: Date.now() - tTwimlStart }, 'twiml-sent');

    if (done) return reply.send(doneTwiml({ speakText, ttsKey, liveUrl, firmId, callSid }));

    const practiceHints = (firmConfig.practice_areas || []).join(', ');
    return reply.send(
      gatherTwiml({
        actionUrl: `${PUBLIC_BASE_URL}/twiml?firmId=${encodeURIComponent(firmId)}`,
        speakText,
        ttsKey,
        liveUrl,
        emptyCount: session.repromptCount,
        hints: practiceHints,
      })
    );
  } catch (err) {
    app.log.error({ err: String(err), stack: err?.stack, callSid }, '/twiml failed');
    reply.header('Content-Type', 'text/xml');
    return reply.send(doneTwiml({ speakText: getErrorMessage(), ttsKey: null }));
  }
});

// POST /twiml-result — Twilio follows this redirect after the filler phrase plays.
// By this point, runNextStepController has had ~1-2s head start; we just await and return real TwiML.
app.post('/twiml-result', async (req, reply) => {
  const callSid = String(req.body?.CallSid || req.query?.callSid || '').trim();
  const firmId = String(req.query?.firmId || 'firm_default').trim();

  reply.header('Content-Type', 'text/xml');

  const pending = pendingResponses.get(callSid);

  if (!pending) {
    app.log.warn({ callSid }, '/twiml-result: no pending response — call may have already completed');
    return reply.send(doneTwiml({ speakText: getErrorMessage(), ttsKey: null }));
  }

  let step;
  try {
    step = await pending.promise;
  } finally {
    pendingResponses.delete(callSid);
  }

  try {
    const { speakText, ttsKey, done } = step.payload;
    const { t1, t2, t3, t4 } = step.payload.timings;
    app.log.info({
      type: 'latency-trace',
      callSid,
      stt_to_openai_ms: t1 - pending.t0,
      openai_ms: t2 - t1,
      compose_ms: t3 - t2,
      tts_ms: t4 - t3,
      total_ms: t4 - pending.t0,
    }, 'latency-trace');

    const liveUrl = !ttsKey
      ? `${PUBLIC_BASE_URL}/tts-live?text=${encodeURIComponent(speakText)}&firmId=${encodeURIComponent(firmId)}`
      : null;

    app.log.info({ callSid, ttsHit: !!ttsKey, liveStream: !!liveUrl }, 'twiml-result-sent');

    if (done) return reply.send(doneTwiml({ speakText, ttsKey, liveUrl, firmId, callSid }));

    const practiceHints = (step.firmConfig.practice_areas || []).join(', ');
    return reply.send(
      gatherTwiml({
        actionUrl: `${PUBLIC_BASE_URL}/twiml?firmId=${encodeURIComponent(firmId)}`,
        speakText,
        ttsKey,
        liveUrl,
        emptyCount: step.session.repromptCount,
        hints: practiceHints,
      })
    );
  } catch (err) {
    app.log.error({ err: String(err), stack: err?.stack, callSid }, '/twiml-result failed');
    return reply.send(doneTwiml({ speakText: getErrorMessage(), ttsKey: null }));
  }
});

// POST /twiml-grace — grace period after Ava's closing line.
// Twilio holds the line for 4 seconds and POSTs here whether or not the caller speaks.
// Speech → un-done the session and continue. Silence → hang up.
app.post('/twiml-grace', async (req, reply) => {
  const callSid = String(req.body?.CallSid || req.query?.callSid || '').trim();
  const firmId = String(req.query?.firmId || 'firm_default').trim();
  const speech = String(req.body?.SpeechResult || '').trim();

  reply.header('Content-Type', 'text/xml');

  if (!speech) {
    app.log.info({ callSid }, 'twiml-grace: silence — hanging up');
    return reply.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }

  app.log.info({ callSid, speech: speech.slice(0, 100) }, 'twiml-grace: caller spoke — continuing');

  const sessions = await loadSessions();
  const session = sessions[callSid];
  if (session) {
    session.done = false;
    sessions[callSid] = session;
    await saveSessions(sessions);
  }

  try {
    const fromPhone = session?.fromPhone || '';
    const result = await runNextStepController({ firmId, callSid, fromPhone, userText: speech });
    const { speakText, ttsKey, done: newDone } = result.payload;
    const liveUrl = !ttsKey
      ? `${PUBLIC_BASE_URL}/tts-live?text=${encodeURIComponent(speakText)}&firmId=${encodeURIComponent(firmId)}`
      : null;
    if (newDone) return reply.send(doneTwiml({ speakText, ttsKey, liveUrl, firmId, callSid }));
    const practiceHints = (result.firmConfig?.practice_areas || []).join(', ');
    return reply.send(gatherTwiml({
      actionUrl: `${PUBLIC_BASE_URL}/twiml?firmId=${encodeURIComponent(firmId)}`,
      speakText, ttsKey, liveUrl,
      emptyCount: result.session.repromptCount,
      hints: practiceHints,
    }));
  } catch (err) {
    app.log.error({ err: String(err), callSid }, '/twiml-grace failed');
    return reply.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
  }
});

// POST /call-status — Twilio status callback; saves partial leads on hangup
app.post('/call-status', async (req, reply) => {
  const callSid = String(req.body?.CallSid || '').trim();
  const callStatus = String(req.body?.CallStatus || '').trim();
  const callDuration = parseInt(req.body?.CallDuration || '0', 10);

  if (callStatus !== 'completed' || !callSid) return reply.code(204).send();

  const sessions = await loadSessions();
  const session = sessions[callSid];

  if (!session) return reply.code(204).send();

  // Always save call duration if available
  if (callDuration > 0 && session.leadId) {
    patchLead(session.leadId, { call_duration_seconds: callDuration })
      .catch((err) => app.log.warn({ err: String(err), callSid }, 'call-status: duration patch failed'));
  }

  // Session already marked done — full lead already saved, just clean up
  if (session.done) {
    deleteSession(callSid).catch((err) => app.log.warn({ err: String(err), callSid }, 'call-status: session delete failed'));
    return reply.code(204).send();
  }

  // Caller hung up before intake completed — persist as partial lead
  app.log.info({ callSid, leadId: session.leadId, callDuration }, 'call-status: saving partial lead');

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

  deleteSession(callSid).catch((err) => app.log.warn({ err: String(err), callSid }, 'call-status: session delete failed'));

  return reply.code(204).send();
});

// POST /recording-status — Twilio recording status callback; saves recording URL to lead
app.post('/recording-status', async (req, reply) => {
  const callSid = String(req.body?.CallSid || '').trim();
  const recordingUrl = String(req.body?.RecordingUrl || '').trim();
  const duration = parseInt(req.body?.RecordingDuration || '0', 10);

  if (!callSid || !recordingUrl) return reply.code(204).send();

  try {
    const sessions = await loadSessions();
    const session = sessions[callSid];
    if (session?.leadId) {
      await patchLead(session.leadId, {
        recording_url: recordingUrl,
        recording_duration: duration,
      });
      app.log.info({ callSid, leadId: session.leadId, duration }, 'recording-saved');
    }
  } catch (err) {
    app.log.warn({ err: String(err), callSid }, 'recording-status handler failed');
  }

  return reply.code(204).send();
});

// GET /api/calls/:id/recording — proxy Twilio recording audio to client
// :id may be the internal call id OR the Twilio callSid (lead.lastCallSid)
app.get('/api/calls/:id/recording', async (req, reply) => {
  const firmId = String(req.query?.firmId || '').trim();
  if (!firmId) return reply.code(400).send({ error: 'firmId required' });
  const callId = req.params.id;
  // Try internal ID first, then fall back to callSid lookup
  let call = await getCallById(callId);
  if (!call) call = await getCallByCallSid(callId);
  if (!call) return reply.code(404).send({ error: 'Not found' });
  if (call.firmId !== firmId) return reply.code(404).send({ error: 'Not found' });

  const leads = await loadLeads(call.firmId);
  const lead = leads.find((l) => l.id === call.leadId);
  if (!lead?.recording_url) return reply.code(404).send({ error: 'No recording' });

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return reply.code(503).send({ error: 'Twilio credentials not configured' });

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  const audioRes = await fetch(`${lead.recording_url}.mp3`, {
    headers: { Authorization: `Basic ${auth}` },
  }).catch(() => null);

  if (!audioRes?.ok) return reply.code(502).send({ error: 'Recording unavailable' });

  reply.header('Content-Type', 'audio/mpeg');
  reply.header('Cache-Control', 'private, max-age=3600');
  return reply.send(Buffer.from(await audioRes.arrayBuffer()));
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
    subscription_data: {
      trial_period_days: 7,
    },
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
      status: firm.status || 'active',
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

  const [allCalls, allLeads] = await Promise.all([loadCalls(firmId), loadLeads(firmId)]);
  const calls = allCalls.filter((c) => c.startedAt >= cutoff);
  const leads = allLeads.filter((l) => l.createdAt >= cutoff);

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

// PATCH /api/admin/firms/:id — suspend or reactivate a firm
app.patch('/api/admin/firms/:id', async (req, reply) => {
  if (requireAdminKey(req, reply) === false) return;
  const firmId = req.params.id;
  const action = req.body?.action; // 'suspend' | 'reactivate'
  if (!firmId) return reply.code(400).send({ error: 'firmId required' });
  if (action !== 'suspend' && action !== 'reactivate') return reply.code(400).send({ error: 'action must be suspend or reactivate' });

  const firm = await loadFirmConfig(firmId);
  const newStatus = action === 'suspend' ? 'suspended' : 'active';
  await saveFirmConfig(firmId, { ...firm, status: newStatus });
  return { ok: true, firmId, status: newStatus };
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
      const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await saveFirmConfig(firmId, {
        ...firm,
        stripe_customer_id: obj.customer,
        stripe_subscription_id: obj.subscription,
        billing_status: 'trialing',
        status: 'trial',
        trial_ends_at: trialEndsAt,
        trial_warning_sent: false,
      });
      // Send welcome email to the customer
      const customerEmail = obj.customer_email || firm.notification_email;
      if (customerEmail && RESEND_API_KEY) {
        const trialEnd = new Date(trialEndsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        const dashboardUrl = `${WEB_BASE_URL}/dashboard?firmId=${encodeURIComponent(firmId)}`;
        const twilioPhone = firm.twilio_phone || '(your Twilio number)';
        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: RESEND_FROM_EMAIL,
            to: customerEmail,
            subject: 'Welcome to Ava — your 7-day trial has started',
            html: `
              <p>Hi there,</p>
              <p>Your Ava intake assistant is ready. Your 7-day free trial runs until <strong>${trialEnd}</strong>.</p>
              <p><strong>Your Ava phone number:</strong> ${twilioPhone}</p>
              <p>Point that number at Ava by setting your Twilio webhook to:<br>
              <code>${PUBLIC_BASE_URL}/twiml?firmId=${encodeURIComponent(firmId)}</code></p>
              <p><a href="${dashboardUrl}">View your dashboard →</a></p>
              <p>Questions? Just reply to this email.</p>
            `,
          }),
        }).catch((err) => app.log.warn({ err: String(err), firmId }, 'welcome email failed'));
      }
    }
  } else if (event.type === 'customer.subscription.updated') {
    const firmId = obj.metadata?.firmId;
    if (firmId) {
      const firm = await loadFirmConfig(firmId);
      const isActive = obj.status === 'active';
      await saveFirmConfig(firmId, {
        ...firm,
        stripe_subscription_id: obj.id,
        billing_status: isActive ? 'active' : obj.status,
        status: isActive ? 'active' : (firm.status || 'trial'),
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
if (!RESEND_API_KEY) {
  app.log.warn('BOOT: RESEND_API_KEY is not set — email notifications will be skipped');
}
if (RESEND_FROM_EMAIL && !RESEND_FROM_EMAIL.endsWith('@resend.dev')) {
  const fromDomain = RESEND_FROM_EMAIL.split('@')[1] || '';
  app.log.warn({ RESEND_FROM_EMAIL, fromDomain }, 'BOOT: RESEND_FROM_EMAIL uses a custom domain — ensure it is verified in the Resend dashboard or emails will be rejected (403)');
}
app.log.info({
  ELEVENLABS_MODEL_ID,
  ELEVENLABS_VOICE_ID: ELEVENLABS_VOICE_ID ? ELEVENLABS_VOICE_ID.slice(0, 8) + '...' : '(unset)',
  ELEVEN_STABILITY:     process.env.ELEVEN_STABILITY     ?? '(default 0.38)',
  ELEVEN_SIMILARITY:    process.env.ELEVEN_SIMILARITY    ?? '(default 0.80)',
  ELEVEN_STYLE:         process.env.ELEVEN_STYLE         ?? '(default 0.38)',
  ELEVEN_SPEAKER_BOOST: process.env.ELEVEN_SPEAKER_BOOST ?? '(default true)',
}, 'BOOT ElevenLabs voice config');

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`HTTP listening on http://127.0.0.1:${PORT}`);

  // Ensure audio directory exists before prewarm (critical on Railway — must be under volume mount)
  await fs.mkdir(AUDIO_DIR, { recursive: true });
  console.log('AUDIO_DIR ready:', AUDIO_DIR);
  if (!AUDIO_DIR.startsWith('/app/data') && !AUDIO_DIR.startsWith('/data')) {
    console.warn('WARNING: AUDIO_DIR is not under a Railway volume mount — cached audio will be lost on redeploy:', AUDIO_DIR);
  }

  // Pre-synthesize hold phrase — must be ready before any call comes in
  holdKey = await synthesizeToDisk(HOLD_PHRASE);
  console.log('hold-phrase ready:', holdKey ? `OK (${holdKey.slice(0, 8)})` : 'FAILED — <Say> still used as last resort');

  // Pre-synthesize filler phrases in parallel — ready before any call comes in
  fillerKeys = await Promise.all(FILLER_PHRASES.map((p) => synthesizeToDisk(p).catch(() => null)));
  const fillerReady = fillerKeys.filter(Boolean).length;
  console.log(`filler-phrases ready: ${fillerReady}/${FILLER_PHRASES.length}`);

  prewarmTtsCache().catch((err) => app.log.warn({ err: String(err) }, 'TTS prewarm error'));
} catch (err) {
  app.log.error({ err: String(err) }, 'Server failed to start');
  process.exit(1);
}