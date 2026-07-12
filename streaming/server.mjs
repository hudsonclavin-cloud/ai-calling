import 'dotenv/config';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import { twilioSignaturePreHandler } from './lib/twilio-signature.mjs';
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
  persistSessionArtifactsUnlocked,
  patchLead,
  getLeadById,
  listLeadsForDashboard,
  createWebhookLog,
  getWebhookLogs,
  withCallLock,
  logEmailAttempt,
} from './db.mjs';

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
const REQUIRED_ENV = ['PUBLIC_BASE_URL', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY'];
if (isMain) {
  for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
      console.error(`FATAL: Missing required env var: ${key}`);
      process.exit(1);
    }
  }
  console.log('[Startup] All required env vars present');
  if (!process.env.NOTIFICATION_EMAIL) {
    console.warn('[Startup] Optional env var NOTIFICATION_EMAIL is not set; default firm notification_email will be empty unless firm_default.json provides one.');
  }
}

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
const STT_LOW_CONFIDENCE_THRESHOLD = Number(process.env.STT_LOW_CONFIDENCE_THRESHOLD ?? 0.55);

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
  'Got it — one sec.',
  'Okay — let me note that.',
];
const QUESTION_FILLER = 'Good question — let me check.';
const CORRECTION_FILLER = 'Ah, got it — one sec.';
const FILLER_PREWARM_PHRASES = [...FILLER_PHRASES, QUESTION_FILLER, CORRECTION_FILLER];
let fillerKeys = []; // populated at boot via synthesizeToDisk
let questionFillerKey = null;
let correctionFillerKey = null;

// Per-session last filler index (avoids consecutive repeated filler within a call)
const fillerLastIdxMap = new Map();
const DYNAMIC_FILLER_TIMEOUT_MS = Number(process.env.DYNAMIC_FILLER_TIMEOUT_MS ?? 800);
const FILLER_GATE_MS = 1200;

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
  notification_email: process.env.NOTIFICATION_EMAIL || '',
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
{
  const settings = getVoiceSettings();
  app.log.info({ settings, settingsHash: sha1(JSON.stringify(settings)).slice(0, 8) }, 'voice-settings-resolved');
}
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
const rateLimitCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [key, hits] of rateLimitStore.entries()) {
    const fresh = hits.filter((t) => t > cutoff);
    if (!fresh.length) rateLimitStore.delete(key);
    else rateLimitStore.set(key, fresh);
  }
}, 5 * 60_000);
rateLimitCleanupTimer.unref?.();

// ── Per-session ack index (avoids repeated acknowledgments) ──────────────────
const sessionAckIndex = new Map();
// Stores in-flight runNextStepController promises keyed by callSid so /twiml-result can await them
const pendingResponses = new Map(); // callSid → { promise, t0 }
const DETERMINISTIC_ACK_ALLOWLIST = ['Got it.', 'Understood.', 'Thanks for that.'];

function normalizeDeterministicAck(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const punctuated = /[.!?]$/.test(text) ? text : `${text}.`;
  return DETERMINISTIC_ACK_ALLOWLIST.find((ack) => ack.toLowerCase() === punctuated.toLowerCase()) || '';
}

function getSafeDeterministicAcks(firmConfig) {
  const acks = firmConfig.acknowledgments?.length ? firmConfig.acknowledgments : DEFAULT_FIRM_CONFIG.acknowledgments;
  const safe = [...new Set(acks.map(normalizeDeterministicAck).filter(Boolean))];
  return safe.length ? safe : ['Got it.'];
}

function getNextAck(callSid, firmConfig, callerContext = 'neutral') {
  if (callerContext === 'urgent_or_distressed' || callerContext === 'caller_question') return '';
  if (callerContext === 'correction') return 'Ah, got it —';
  const acks = getSafeDeterministicAcks(firmConfig);
  const last = sessionAckIndex.get(callSid) ?? -1;
  const next = (last + 1) % acks.length;
  sessionAckIndex.set(callSid, next);
  return acks[next];
}

// Read the next ack without advancing the index (used for speculative TTS prefetch)
function peekNextAck(callSid, firmConfig, callerContext = 'neutral') {
  if (callerContext === 'urgent_or_distressed' || callerContext === 'caller_question') return '';
  if (callerContext === 'correction') return 'Ah, got it —';
  const acks = getSafeDeterministicAcks(firmConfig);
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

// (Fix B) Remove a leading throwaway acknowledgment ("Perfect." / "Great," / "Okay —")
// from Ava speech. These read as tone-deaf on sensitive calls and are what the launch
// evaluator flags. Deterministic; only strips a single leading filler token.
const PROHIBITED_LEADING_ACK = /^\s*(perfect|great|awesome|excellent|wonderful|fantastic|amazing|right|mm-?hm+|okay|ok|alright|all right|of course|sure|got it|gotcha)\b[\s.,!—–-]*/i;
function stripLeadingProhibitedAck(text) {
  let s = String(text || '');
  if (!PROHIBITED_LEADING_ACK.test(s)) return s;
  s = s.replace(PROHIBITED_LEADING_ACK, '');
  s = s.replace(/^\s*([a-z])/, (_, c) => c.toUpperCase());
  return s.trim();
}

// (Fix B) Deterministic, context-aware closing policy. Sensitive, refusal, and
// correction closings never claim "everything I need" and never lead with a
// prohibited acknowledgment. Neutral closings reuse the firm's line, sanitized.
function selectClosing(session, firmConfig) {
  const base = firmConfig?.closing || DEFAULT_FIRM_CONFIG.closing;
  if (session.isUrgent) {
    return "I'm really glad you reached out. I've noted everything for the team so the right person can follow up with you as soon as possible.";
  }
  if (session.refusedField) {
    return "I've noted what you were able to share, and someone from the office will follow up with you.";
  }
  if (session.hadCorrection) {
    return "Thanks for clarifying that — I've got the updated details, and someone from the office will follow up with you.";
  }
  const cleaned = stripLeadingProhibitedAck(base);
  return cleaned || base;
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

function getVoiceSettings(env = process.env) {
  return {
    stability: Number(env.ELEVEN_STABILITY ?? 0.55),
    similarity_boost: Number(env.ELEVEN_SIMILARITY ?? 0.75),
    style: Number(env.ELEVEN_STYLE ?? 0.10),
    use_speaker_boost: env.ELEVEN_SPEAKER_BOOST !== 'false',
    speed: Number(env.ELEVEN_SPEED ?? 1.00),
  };
}

function makeTtsCacheKey({ voiceId, modelId, settings, text }) {
  return sha1(JSON.stringify({ v: 2, voiceId, modelId, settings, text }));
}

function normalizeInternalClarifyingNote(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function parseSpeechConfidence(raw) {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function isLowSpeechConfidence(confidence, threshold = STT_LOW_CONFIDENCE_THRESHOLD) {
  return confidence != null && confidence < threshold;
}

function exactFieldClarification(field) {
  if (field === 'full_name') return 'Sorry — I may have heard the name wrong. Could you say your name once more?';
  if (field === 'callback_number') return 'Sorry — I may have missed a digit. Could you repeat the callback number?';
  return '';
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
  const defaultRaw = id === 'firm_default'
    ? raw
    : await readJson(path.join(FIRMS_DIR, 'firm_default.json'), null);
  const baseConfig = defaultRaw ? { ...DEFAULT_FIRM_CONFIG, ...defaultRaw } : { ...DEFAULT_FIRM_CONFIG };
  if (!raw) {
    app.log.warn(`Firm config not found for "${id}", using default`);
    return { ...baseConfig };
  }
  // Merge with defaults so missing keys always have a safe value
  const industry = raw.industry || baseConfig.industry || DEFAULT_FIRM_CONFIG.industry;
  return {
    ...baseConfig,
    ...raw,
    question_overrides: { ...baseConfig.question_overrides, ...(raw.question_overrides || {}) },
    acknowledgments: raw.acknowledgments?.length ? raw.acknowledgments : baseConfig.acknowledgments,
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

// ── Deterministic phone extraction (callback integrity) ───────────────────────
// Spoken number-words → digits. 'oh'/'o' map to zero. Nothing else is a digit.
const SPOKEN_DIGITS = {
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9',
};

// Convert a caller utterance into an ordered digit string, mapping spoken digit
// words to digits and preserving literal digit runs. Separators/filler words are
// ignored. Returns { digits, sawWord, sawDigit } for provenance.
function spokenToDigits(text) {
  const tokens = String(text || '').toLowerCase().replace(/[+(),.\-]/g, ' ').split(/\s+/).filter(Boolean);
  let digits = '', sawWord = false, sawDigit = false;
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) { digits += tok; sawDigit = true; }
    else if (Object.prototype.hasOwnProperty.call(SPOKEN_DIGITS, tok)) { digits += SPOKEN_DIGITS[tok]; sawWord = true; }
  }
  return { digits, sawWord, sawDigit };
}

// Deterministic phone parse (Invariants 1-3): direct digits, spoken digit-words,
// and mixed forms. Returns { normalized, provenance } for a COMPLETE 10- or 11-digit
// US number, or null for absent / partial / ambiguous input — it never guesses or
// expands an incomplete number.
function extractPhoneCandidate(text) {
  const { digits, sawWord, sawDigit } = spokenToDigits(text);
  let normalized = null;
  if (digits.length === 10) normalized = `+1${digits}`;
  else if (digits.length === 11 && digits[0] === '1') normalized = `+${digits}`;
  if (!normalized) return null;
  const provenance = (sawWord && sawDigit) ? 'digits_mixed' : sawWord ? 'digits_spoken_words' : 'digits_direct';
  return { normalized, provenance };
}

// Explicit callback-correction intent (Invariant 4) — utterance-driven, independent
// of lastQuestionId. Pair with a valid extractPhoneCandidate at the call site.
function detectPhoneCorrectionIntent(text) {
  const t = String(text || '').toLowerCase().trim();
  if (/^(no|nope)\b/.test(t) && /\b(number|it'?s|its|the|actually|zero|oh|one|two|three|four|five|six|seven|eight|nine)\b|\d/.test(t)) return true;
  if (/\bthat'?s (wrong|not right|incorrect)\b/.test(t)) return true;
  if (/\bwrong number\b/.test(t)) return true;
  if (/\b(the )?(correct|right) number is\b/.test(t)) return true;
  if (/\bi (said|meant)\b/.test(t)) return true;
  if (/\bactually\b/.test(t) && /\b(use|number|it'?s|reach me at)\b/.test(t)) return true;
  if (/\b(change|update|different)\b.*\bnumber\b/.test(t)) return true;
  return false;
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
    collected[field] = '';
  }
  // Also initialize any firm-specific fields not in the default set
  for (const field of (firmConfig.required_fields || REQUIRED_FIELDS_DEFAULT)) {
    if (!(field in collected)) {
      collected[field] = '';
    }
  }
  collected.calling_for = '';

  return {
    callSid,
    firmId,
    fromPhone,
    phoneFromCallerId: fromPhone || '',
    callId: `call_${sha1(`${callSid}|${firmId}`)}`,
    leadId: `lead_${sha1(`${firmId}|${fromPhone}`)}`,
    turnCount: 0,
    repromptCount: 0,
    callerType: null,          // null | 'new' | 'returning'
    callerTypeReprompts: 0,    // failed detection attempts before defaulting
    knownName: '',             // set when returning caller is detected with a known name
    carriedCallback: '',       // prior-call number to CONFIRM (never auto-trusted) for returning callers
    isUrgent: false,           // true when urgency keywords detected
    urgencySpoken: false,      // true after urgency acknowledgment has been spoken
    phoneRetryPending: false,  // true when caller gave digits but extraction failed
    phoneRetryUsed: false,     // ensures only one phone retry per session
    callbackProvenance: '',    // extraction source of callback_number (debug/provenance, in-memory only)
    urgencyCategory: '',       // classifyUrgency category when isUrgent (in-memory only)
    hadCorrection: false,      // caller corrected a field this call (closing context)
    hadCallerQuestion: false,  // caller asked Ava a question this call (closing context)
    refusedField: '',          // a required field the caller explicitly refused to give
    refusalCounts: {},         // per-field count of explicit refusals (stop re-asking)
    askedQuestionIds: [],
    collected,
    lastQuestionId: '',
    lastQuestionText: '',
    lastSpeechConfidence: null,
    internalClarifyingNote: '',
    transcript: [],
    disclaimerShown: false,
    done: false,
    notified: false,           // idempotency latch — true once notifications have been dispatched
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

const AFFIRMATIVE_WORDS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'right', 'ok', 'okay',
  'sounds good', 'that works', "that's right", "that's correct", 'still good',
  'same number', 'same', 'uh huh', 'mm hm', 'mhm',
]);

// Returning-caller callback confirmation: does this utterance affirm the on-file
// number? Negatives / "different number" short-circuit to false so we never treat
// a correction as confirmation.
function isAffirmative(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!,?]+$/, '');
  if (!t) return false;
  if (/\b(no|nope|different|another|change|wrong)\b/.test(t)) return false;
  if (AFFIRMATIVE_WORDS.has(t)) return true;
  if (t.length <= 40 && /\b(yes|yeah|yep|correct|that's right|still (good|works)|same( number)?)\b/.test(t)) return true;
  return false;
}

function extractStructuredDeterministic(userText, expectedField = '') {
  const text = String(userText || '').trim();
  if (!text) return {};

  // Skip short acknowledgments and filler phrases, but let expected direct names
  // reach the contextual validator before being discarded.
  const directExpectedName = expectedField === 'full_name' && isLikelyName(text, text, expectedField);
  if (!directExpectedName && (text.length < 10 || FILLER_WORDS.has(text.toLowerCase()))) return {};

  const extracted = {};
  const phoneMatch = text.match(/(\+?\d[\d\s().-]{8,}\d)/);
  if (phoneMatch) extracted.callback_number = normalizePhone(phoneMatch[1]);

  const nameMatch = text.match(/(?:my name is|this is|i(?:'|’)?m|i am)\s+([A-Za-z.'\-\s]{2,})/i);
  const nameCandidate = nameMatch ? nameMatch[1].trim() : (expectedField === 'full_name' ? text : '');
  if (nameCandidate && isLikelyName(nameCandidate, text, expectedField)) extracted.full_name = nameCandidate;

  const lower = text.toLowerCase();
  if (lower.includes('injury') || lower.includes('accident')) extracted.practice_area = 'Personal Injury';
  else if (lower.includes('divorce') || lower.includes('custody') || lower.includes('family')) extracted.practice_area = 'Family Law';
  else if (lower.includes('employment') || lower.includes('termination') || lower.includes('harassment')) extracted.practice_area = 'Employment';
  else if (lower.includes('immigration') || lower.includes('visa') || lower.includes('deportation')) extracted.practice_area = 'Immigration';
  else if (lower.includes('criminal') || lower.includes('arrested') || lower.includes('charged')) extracted.practice_area = 'Criminal Defense';

  const words = text.split(/\s+/).filter(Boolean);
  // Gate case_summary on whether a VALID name was actually extracted, not on a raw
  // "I'm …" prefix match — "I'm scared, my husband hit me" is a distress summary, not a
  // name statement, and must still be captured (Fix A/E). A spoken phone number (word or
  // mixed form) must not leak into case_summary just because it reads like a phrase.
  if (!extracted.full_name && !phoneMatch && !extractPhoneCandidate(text) && isLikelySummary(text, expectedField)) extracted.case_summary = text;
  return extracted;
}

function detectCallerType(text) {
  const lower = String(text || '').toLowerCase();
  if (/\b(new|first[\s-]?time|never called|first call|new client)\b/.test(lower)) return 'new';
  if (/\b(existing|returning|current client|already (a client|working with you|have a case here)|i('ve| have) called (you|here|before|already)|previous(ly)?|already a client|you (already )?have my (info|information|number|file))\b/.test(lower)) return 'returning';
  return null;
}

// Ordered urgency signal groups (Fix C). Precision-first: a bare incident type
// ("car accident", "rear-ended") is NOT urgent — only immediacy, safety, violence,
// arrest, or severe-injury language is. Recall covers fear + implied-danger phrasing.
const URGENCY_SIGNALS = [
  { category: 'domestic_violence', re: /\b(hit me|beat me|beat(en)? up|hurt me|attacked me|assault(ed|ing)?|domestic violence|restraining order|protective order|(he|she|they)('?s| is| has been| been) violent)\b/ },
  { category: 'active_threat', re: /\b(threaten(ed|ing)?|following me|stalking me|being (followed|stalked)|followed me|coming after (me|us)|has a (gun|knife|weapon)|going to (hurt|kill)|kill (me|us)|hurt (me|us|the kids))\b/ },
  { category: 'immediate_safety', re: /\b(don'?t feel safe|do(es)?n'?t (feel|think).{0,25}safe|not safe|aren'?t safe|isn'?t safe|unsafe|in danger|outside my (house|door|home)|need to get (out|away)|get (out|away) (tonight|now|right now)|somewhere safe|leave (tonight|right now|immediately))\b/ },
  { category: 'immediate_safety', re: /\bout of the (house|home)\b[^.?!]*\b(tonight|right now|now|immediately|tonight)\b/ },
  { category: 'severe_injury', re: /\b(bleeding( badly| a lot)?|can'?t breathe|badly hurt|seriously (hurt|injured)|severely (hurt|injured)|broke my|broken (bone|arm|leg|rib)|unconscious|passed out|chest pain|knocked out|hit by a car|just (got|been) hurt)\b/ },
  { category: 'medical_emergency', re: /\b(at the (hospital|er)|in the (hospital|er)|emergency room|ambulance|call(ed|ing)? 911|urgent care right now)\b/ },
  { category: 'arrest_or_detention', re: /\b(arrested|in jail|in custody|being held|holding (him|her|them)|detained|locked up|going to jail|court (tomorrow|in the morning)|post bail|bonded out)\b/ },
  { category: 'emergency_immediacy', re: /\b(emergency|right now|immediately|as soon as possible|do something fast|need (help|to do something) (fast|now|immediately)|need to act fast)\b/ },
  { category: 'fear', re: /\b(scared|frightened|terrified|petrified|panicking|freaking out|so afraid|really afraid)\b/ },
];

// Negated-safety context — the caller asserts they are NOT in danger. Suppresses the
// soft fear/safety tiers so "I was scared but I'm safe now" is not flagged urgent.
const URGENCY_NEGATION = /(not in danger|no(?: one| body)?(?: is)? (?:threaten|follow)\w*|i'?m safe now|we'?re safe now|(?:is|are|we'?re|i'?m|everyone'?s|everything'?s) (?:safe|fine|okay|ok) now|no danger|nothing like that|not scared anymore)/;

// Structured urgency classifier. Returns { urgent, category, signals, confidence }.
function classifyUrgency(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return { urgent: false, category: 'routine', signals: [], confidence: 'none' };
  const negated = URGENCY_NEGATION.test(lower);
  const hits = [];
  for (const { category, re } of URGENCY_SIGNALS) {
    if (re.test(lower)) hits.push(category);
  }
  // A negated-safety assertion ("no one is threatening me", "I'm safe now") negates
  // the threat/fear/safety tiers — drop them. Keep only factual hard events that a
  // safety negation cannot undo (violence, severe injury, medical, arrest).
  const soft = new Set(['fear', 'immediate_safety', 'emergency_immediacy', 'active_threat']);
  const effective = negated ? hits.filter((c) => !soft.has(c)) : hits;
  if (!effective.length) return { urgent: false, category: 'routine', signals: [], confidence: negated ? 'negated' : 'none' };
  const hard = effective.some((c) => c !== 'fear' && c !== 'emergency_immediacy');
  return {
    urgent: true,
    category: effective[0],
    signals: [...new Set(effective)],
    confidence: hard ? 'high' : 'medium',
  };
}

function detectUrgency(text) {
  return classifyUrgency(text).urgent;
}

function classifyFillerContext(userText) {
  const text = String(userText || '').trim();
  const lower = text.toLowerCase();
  if (detectUrgency(text) || /\b(hit me|domestic violence|protective order|restraining order|afraid|scared|terrified|hospital|serious accident|bad accident|severe injury|badly hurt|arrested|in jail)\b/.test(lower)) {
    return 'urgent_or_distressed';
  }
  if (/^(no[,.\s]+(?:that'?s|its|it's|the|my)|actually\b|that'?s not right\b|wrong number\b|i said\b|not that\b|different\b)/i.test(text)) {
    return 'correction';
  }
  if (isCallerQuestion(text)) return 'caller_question';
  return 'neutral';
}

function selectThinkingFiller(userText, lastFillerIdx = -1, callerContext = classifyFillerContext(userText)) {
  const category = callerContext;
  if (category === 'urgent_or_distressed') return { category, text: null, fillerIdx: null };
  if (category === 'caller_question') return { category, text: QUESTION_FILLER, fillerIdx: null };
  if (category === 'correction') return { category, text: CORRECTION_FILLER, fillerIdx: null };
  const fillerIdx = FILLER_PHRASES.length > 1 ? (lastFillerIdx + 1) % FILLER_PHRASES.length : 0;
  return { category, text: FILLER_PHRASES[fillerIdx], fillerIdx };
}

function detectEarlyExit(text) {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return false;
  // (Fix F) Unambiguous exit intents — no destination sense, safe to fire on directly.
  if (/\b(never\s*mind|nevermind|forget it|scratch that|disregard|not interested|changed my mind|i don'?t need help|i'?m (all set|good for now)|no thanks?|good\s*bye|goodbye|bye( now)?|i'?m done|end (the |this )?call|hang up|maybe another time|some other time|call me later)\b/.test(lower)) {
    return true;
  }
  // "call (you) back" / "try again" / "reach out later" — an exit, and distinct from
  // "call my doctor" (which names a person to contact, not a callback intent).
  if (/\b(i|we)\b[^.?!]*\b(call (you |u )?back|call back|call again|try (you )?again|reach out later)\b/.test(lower)) return true;
  if (/\bcan i call (you )?back\b/.test(lower)) return true;
  if (/\bcan'?t talk (right now|now|at the moment|at the minute)\b/.test(lower)) return true;
  // "have/need/gotta to go|run" — an exit ONLY when the caller is not naming a
  // destination ("go to the hospital", "go back to work", "go pick up the kids").
  if (/\b(have|need|got|gotta)\s+to?\s*(go|run|hop off|get going|get off)\b/.test(lower)
      || /\bi'?ll let you go\b/.test(lower)) {
    if (/\bgo\s+(to|back|pick|get|see|check|grab|home|and)\b/.test(lower)) return false;
    return true;
  }
  return false;
}

// Explicit refusal to provide a specific field (Fix D/G) — "I'd rather not say",
// "I don't want to give my number", "can you just take my info". Utterance-driven.
function detectRefusal(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  if (/\b(rather not (say|give|share)|prefer not to (say|give|share)|don'?t want to (give|share|say)|won'?t give|not comfortable (giving|sharing)|not (gonna|going to) give|no comment)\b/.test(t)) return true;
  if (/\bcan you just take (my|the) (info|information|message)\b/.test(t)) return true;
  return false;
}

// Tokens that are never part of a real caller name. If any word of a name
// candidate appears here the candidate is an emotional / physical / safety
// state or a case description — not a name. Deliberately broad; real names do
// not collide with these. (Fix A — name integrity.)
const NON_NAME_WORDS = new Set([
  // emotional state
  'scared', 'afraid', 'frightened', 'terrified', 'worried', 'anxious', 'nervous',
  'upset', 'overwhelmed', 'confused', 'panicked', 'panicking', 'distraught', 'shaken',
  'stressed', 'freaking', 'crying', 'desperate', 'helpless', 'hopeless', 'devastated',
  // physical state
  'injured', 'hurt', 'hurting', 'bleeding', 'banged', 'bruised', 'sore', 'dizzy',
  'sick', 'nauseous', 'unconscious', 'broken', 'aching', 'limping', 'concussed',
  'wounded', 'bandaged', 'paralyzed', 'numb',
  // safety state
  'unsafe', 'trapped', 'stuck', 'threatened', 'followed', 'stranded', 'cornered',
  'allowed', 'danger', 'dangerous', 'abused', 'assaulted', 'attacked', 'stalked',
  // case description / incident
  'crash', 'accident', 'wreck', 'collision', 'injury', 'lawsuit', 'divorce', 'custody',
  'arrested', 'evicted', 'fired', 'terminated', 'harassment', 'eviction', 'bankruptcy',
  'ticket', 'dui', 'charged', 'sued', 'fell', 'slipped',
  // intensifiers / fillers that only appear around states, never in names
  'really', 'very', 'super', 'kinda', 'pretty', 'badly', 'severely', 'barely',
  'not', 'just', 'still', 'about', 'trying', 'rather',
  // relational / third-party words seen in distress openings
  'husband', 'wife', 'boyfriend', 'girlfriend', 'partner', 'someone', 'somebody',
]);

// Deterministic name-candidate classifier (Fix A). Returns { accepted, reason }.
// A value becomes full_name only when Ava is asking for the name, the caller made
// an explicit name statement, or an explicit name correction — AND the candidate is
// semantically a name, not a state/description/refusal. Never uses an LLM.
function classifyNameCandidate(candidate, { sourceText = '', expectedField = '', correctionIntent = false } = {}) {
  const v = String(candidate || '').trim();
  if (!v) return { accepted: false, reason: 'empty' };
  const sourceHasNamePrefix = /(?:my name is|this is|i(?:'|’)?m|i am|i'?m called|call me|it'?s)\s+[A-Za-z]/i.test(sourceText);
  // Field/intent gate: only accept when the name was actually solicited or volunteered.
  if (expectedField !== 'full_name' && !sourceHasNamePrefix && !correctionIntent) {
    return { accepted: false, reason: 'unexpected_field' };
  }
  if (/\d/.test(v)) return { accepted: false, reason: 'digit_dominated' };
  if (!/^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}$/.test(v)) {
    return { accepted: false, reason: 'invalid_characters' };
  }
  const words = v.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 4) return { accepted: false, reason: 'too_many_tokens' };
  const lower = v.toLowerCase();
  if (FILLER_WORDS.has(lower) || AFFIRMATIVE_WORDS.has(lower)) return { accepted: false, reason: 'filler' };
  if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)$/i.test(v)) {
    return { accepted: false, reason: 'weekday_or_month' };
  }
  // Refusal / non-answer ("I'd rather not say", "I don't want to give my name").
  if (/\b(rather not|don'?t want|won'?t|prefer not|not comfortable|no comment|none of)\b/i.test(v)) {
    return { accepted: false, reason: 'refusal' };
  }
  // Any state / incident word disqualifies the whole candidate.
  const stateWord = words.find((w) => NON_NAME_WORDS.has(w.toLowerCase().replace(/[.'-]+$/, '')));
  if (stateWord) return { accepted: false, reason: 'non_name_state' };
  // Legacy case-description guard (multi-word phrases).
  if (/\b(personal|case|rear-ended|matter|help|legal|consultation|problem|situation|hospital|police|court|jail)\b/i.test(v)) {
    return { accepted: false, reason: 'case_description' };
  }
  return { accepted: true, reason: 'name' };
}

function isLikelyName(value, sourceText = '', expectedField = '') {
  return classifyNameCandidate(value, { sourceText, expectedField }).accepted;
}

// Explicit name-correction intent (Fix A) — utterance-driven, lets a caller replace
// a previously captured name ("no, my name is Gregory Tan" / "actually it's Sean").
function detectNameCorrectionIntent(text) {
  const t = String(text || '').toLowerCase().trim();
  if (/^(no|nope|actually)\b/.test(t) && /(name|it'?s|i'?m|spelled|call me)\b/.test(t)) return true;
  if (/\b(my name is|the name is|it'?s spelled|i (said|meant)|correct name is)\b/.test(t)) return true;
  if (/\bnot\b.*\b(it'?s|my name)\b/.test(t)) return true;
  return false;
}

function isLikelyPhone(value) {
  const normalized = normalizePhone(value);
  return normalized.startsWith('+') && normalized.replace(/\D/g, '').length >= 10;
}

function isLikelySummary(value, expectedField = '') {
  const v = String(value || '').trim();
  if (!v) return false;
  const lower = v.toLowerCase();
  if (FILLER_WORDS.has(lower) || AFFIRMATIVE_WORDS.has(lower)) return false;
  if (isLikelyPhone(v)) return false;
  // (Fix E) A question the caller asked ("how much does this cost?", "am I talking to
  // an AI?") or a refusal is NOT an incident summary — don't let it fill case_summary,
  // so Ava still asks "what happened" and captures the real reason for the call.
  if (isCallerQuestion(v)) return false;
  if (detectRefusal(v)) return false;
  const words = v.split(/\s+/).filter(Boolean);
  if (expectedField === 'case_summary') {
    if (words.length < 3) return false;
    if (isLikelyName(v, '', 'full_name')) return false;
    const meaningful = words.filter((w) => !/^(a|an|the|and|or|but|for|to|of|on|in|at|is|was|were|my|i|we|he|she|they|it|this|that)$/i.test(w));
    return meaningful.length >= 1;
  }
  if (isLikelyName(v, '', 'full_name')) return false;
  const meaningful = words.filter((w) => !/^(a|an|the|and|or|but|for|to|of|on|in|at|is|was|were|my|i|we|he|she|they|it|this|that)$/i.test(w));
  return words.length >= 8 && meaningful.length >= 3;
}

// Aggressive extraction for rambling callers (>100 words).
// Differs from extractStructuredDeterministic in two ways:
//  1. Captures case_summary even when name/phone are also present
//  2. Lowers the case_summary word threshold to 15 words
function extractAllFieldsFromLongResponse(text, expectedField = '') {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length <= 100) return extractStructuredDeterministic(text, expectedField);

  const extracted = {};
  const phoneMatch = text.match(/(\+?\d[\d\s().-]{8,}\d)/);
  if (phoneMatch) extracted.callback_number = normalizePhone(phoneMatch[1]);

  const nameMatch = text.match(/(?:my name is|this is|i(?:'|’)?m|i am)\s+([A-Za-z.'\-\s]{2,})/i);
  if (nameMatch && isLikelyName(nameMatch[1].trim(), text, expectedField)) extracted.full_name = nameMatch[1].trim();

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
  // A carried callback number from a prior call is UNVERIFIED for this call, so
  // callback_number stays required — but phrased as a confirmation. Only the last
  // 4 digits are ever spoken (a spoofed/mistyped caller ID must not leak a stored
  // number). audit R3 / Defect B (04:37 lead had a number Ava never asked for).
  const carriedDigits = String(session.carriedCallback || '').replace(/\D/g, '');
  const last4 = carriedDigits.slice(-4);
  const callbackQuestion = last4
    ? `I have a number ending in ${last4} on file — is that still the best way to reach you, or is there a better number?`
    : "And what's the best number to reach you?";
  return {
    ...firmConfig,
    required_fields: ['full_name', 'case_summary', 'callback_number'],
    question_overrides: {
      ...firmConfig.question_overrides,
      case_summary: "Got it. And briefly, what's the reason for your call today?",
      callback_number: callbackQuestion,
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
  // A field the caller explicitly refused is not askable — asking it again is the
  // repeated-question loop (Fix D/G). It stays "missing" but we never re-request it.
  const refused = session.refusedField ? new Set([session.refusedField]) : new Set();
  const missing = requiredFields.filter((field) => !String(session.collected[field] || '').trim());
  const askable = missing.filter((f) => !refused.has(f));
  if (!askable.length) return { done: true, nextField: null, nextQuestionId: null, nextQuestionText: '' };

  // Scan all askable fields for the first one not yet asked, not just askable[0].
  // Checking only [0] would allow a filler response to exhaust the "unasked"
  // slot and jump to final_clarify, skipping intermediate required fields.
  const nextField = askable.find((f) => !session.askedQuestionIds.includes(f)) ?? askable[0];

  if (!session.askedQuestionIds.includes(nextField)) {
    return {
      done: false,
      nextField,
      nextQuestionId: nextField,
      nextQuestionText: getQuestionText(nextField, firmConfig),
    };
  }

  // Every askable required field has been asked at least once — one final chance
  if (!session.askedQuestionIds.includes('final_clarify')) {
    return {
      done: false,
      nextField: askable[0],
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
    prior_internal_note: normalizeInternalClarifyingNote(session.internalClarifyingNote) || null,
    speech_confidence: session.lastSpeechConfidence,
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
  const firm_name = firmConfig.name || (() => {
    app.log.warn({ firmId: firmConfig.id }, 'prompt-builder: firm_name is missing — using fallback');
    return 'the firm';
  })();

  // Pre-compute collection state so the LLM doesn't have to diff raw JSON
  const fieldLabels = { full_name: 'name', callback_number: 'callback number', practice_area: 'practice area', case_summary: 'case summary' };
  const alreadyCollected = requiredFields
    .filter((f) => String(session.collected[f] || '').trim().length >= 2)
    .map((f) => `${fieldLabels[f] || f} (${session.collected[f]})`)
    .join(', ');
  const stillNeeded = requiredFields
    .filter((f) => String(session.collected[f] || '').trim().length < 2)
    .map((f) => fieldLabels[f] || f)
    .join(', ');
  const collectionStateBlock = alreadyCollected
    ? `Already collected: ${alreadyCollected}.\nStill needed: ${stillNeeded || 'nothing — ready to close'}.`
    : `Nothing collected yet.\nStill needed: ${stillNeeded}.`;

  const practiceAreasStr = (firmConfig.practice_areas || []).join(', ') || 'General';
  const intakeRulesStr = firmConfig.intake_rules ? String(firmConfig.intake_rules).slice(0, 500) : 'None.';
  const urgentLine = session.isUrgent
    ? 'This caller is flagged urgent. Lead with: "I hear you — let\'s make sure we get the right person on this right away." Then collect only what\'s essential before routing.'
    : '';

  const systemPrompt = `You are ${ava_name}, the AI intake specialist answering phones for ${firm_name}. Your job: make the caller feel heard, collect what the attorney needs, and close the call gracefully.

IDENTITY & LEGAL GUARDRAILS (never break these):
- Never give legal advice, predict outcomes, estimate case value, or quote fees. Deflect warmly: "That's exactly what the attorney will go over with you."
- Never promise the firm will take the case or that an attorney-client relationship exists.
- If the caller describes an emergency in progress or danger to anyone, tell them to hang up and call 911 first.
- Never ask for Social Security numbers, bank details, or card numbers.
- If asked whether you're a robot or AI, say yes plainly in one sentence and keep helping. Never deny it.

STYLE:
- 1-2 short sentences per turn. Spoken phrasing, contractions (I'm, that's, we'll), fragments welcome.
- Warm and steady, not bubbly. ${toneInstruction}
- Acknowledge before you ask: reflect the caller's last meaningful point in one short clause, then ask the next question.
- Empathy is one clause — "I'm sorry that happened —" then keep moving. Never apologize twice in a row.
- At most one backchannel per turn. Never a generic filler that ignores what they said.
- Mirror the caller's own words when safe to repeat.
- Every reply is a full conversational turn — at least one complete sentence. Never a bare "Okay." or "Noted."
- Never repeat your previous line. If you must re-ask, rephrase it.

CONVERSATION RULES:
1. One question per turn. Never stack two.
2. Never re-ask anything listed as already collected below.
3. If callback_number came from caller ID, confirm it conversationally: "And the best number for you is the one you're calling from?"
4. If they ramble, don't fight it — pull what you need, acknowledge the core of it, then ask for the single most important missing piece.
5. If they're upset or scared, validate first, shorten your questions, drop the pleasantries.
6. If the matter falls outside the firm's practice areas, say so honestly, still collect name and callback, note the mismatch in clarifying_note (e.g. "Caller described bankruptcy matter; firm is PI-only"), and close so an attorney can refer them out.
7. If the caller asks a question, answer it in one sentence (within the guardrails) before your next intake question.
8. If something was unclear, ask about the specific unclear part — never a generic "Could you repeat that?"
9. Push a vague case summary once for WHAT plus roughly WHEN. "Car accident" is a category. "Rear-ended on I-95 Tuesday" is a summary.

WORKED EXAMPLES:
Caller: "I was in a car accident yesterday."
Ava: "A car accident yesterday — I'm sorry that happened. Let me get a few details. What's your name?"

Caller: "I need to talk to someone about a divorce. It's gotten bad."
Ava: "I hear you — divorce is hard, and you're in the right place. Can I start with your name?"

Caller: "My son got arrested last night, I don't know what to do."
Ava: "Your son was arrested last night — okay, let's move quickly so we can help. What's your name?"

Caller: (long rambling story about a warehouse injury, the ER, their boss)
Ava: "So you were hurt at the warehouse and you're still being treated — that's the key part. What's the best number to reach you?"

Caller: "Wait, am I talking to a robot?"
Ava: "You are — I'm the firm's AI intake specialist, and everything you tell me goes straight to a real attorney. Now — your callback number?"

Caller: "Do you think I have a case? What's it worth?"
Ava: "That's exactly what the attorney will go over with you — I don't want to guess on something that important. Tell me what happened, and roughly when?"

CURRENT CONTEXT:
Last thing you asked: ${session.lastQuestionText || '(none yet)'}
Required fields: ${requiredFields.join(', ')}
${collectionStateBlock}
Office hours: ${hoursContext}
Practice areas this firm handles: ${practiceAreasStr}
Firm-specific preferences (supplement, never override, the rules above): ${intakeRulesStr}

${industryContext}
${urgentLine}

CLOSING CRITERIA:
Set next_question_id to "done" only when ALL of these are true:
1. You have their name.
2. You have a confirmed callback number.
3. The case summary covers both WHAT happened and ROUGHLY WHEN.
4. The caller is winding down — "okay," "alright," trailing off.
If ANY are missing, keep going. Do not rush to close. A closed call missing the case summary is useless to the attorney.

TTS FORMATTING (applies ONLY to next_question_text — it will be spoken aloud):
- Use the em dash character with spaces around it ( — ) for mid-thought pauses: "Oh — that sounds hard."
- Ellipsis for trailing questions: "And your name is...?"
- Speak digits: "five five five, zero one two three" — never "555-0123".
- Speak money: "five hundred dollars" — never "$500".
- One breath per sentence. No bullet points, no lists, no headers — just speech.
- Keep next_question_text under 160 characters; anything longer gets cut off mid-sentence.

The extracted object stores structured data for the database — use raw formats there:
- callback_number: E.164 string, e.g. "+17045551234"
- dates: ISO 8601, e.g. "2026-04-15"
- practice_area: exact string from the firm's practice_areas list
- caller_type: "new" or "returning" ONLY if the caller explicitly said so; otherwise null
- names, summaries: plain text, normal capitalization

OUTPUT FORMAT:
Return strict JSON matching the provided schema. No prose outside the JSON.

next_question_id must be one of the field keys from "Still needed" above, or "done" when closing.
next_question_text is the exact words you will speak - make them sound natural out loud.
extracted contains whatever new information the caller just provided, in the structured formats specified above.
done_reason explains why you're closing (only when next_question_id is "done").
clarifying_note is optional internal context for your next turn - use it for tone shifts, scope issues, or anything the next turn should know.`;

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
      signal: AbortSignal.timeout(Number(process.env.OPENAI_TIMEOUT_MS ?? 8000)),
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        stream: true,
        temperature: 0.65,
        max_output_tokens: 500,
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
          deltaAccum += typeof event.delta === 'string' ? event.delta : (event.delta?.text || '');
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
  const expectedField = session.lastQuestionId;
  const nameCorrection = detectNameCorrectionIntent(userText);
  const updates = {};
  for (const key of requiredFields) {
    const value = String(extracted?.[key] ?? '').trim();
    if (!value) continue;
    if (key === 'full_name' && !isLikelyName(value, userText, expectedField)) continue;
    if (key === 'callback_number' && !isLikelyPhone(value)) continue;
    if (key === 'case_summary' && !isLikelySummary(value, expectedField)) continue;
    const existing = String(session.collected[key] || '').trim();
    // Name overwrite protection (Fix A): a valid, collected name is authoritative —
    // only replace it on an explicit name correction or when Ava is re-asking the name.
    // Blocks unrelated LLM re-proposals from silently swapping a good name.
    if (key === 'full_name' && existing && existing !== value
        && !nameCorrection && expectedField !== 'full_name') continue;
    // Summary overwrite protection (Fix E): don't let a weaker/shorter LLM summary
    // replace a good one already captured, unless Ava is explicitly on the summary turn.
    if (key === 'case_summary' && existing && existing !== value
        && value.length < existing.length && expectedField !== 'case_summary') continue;
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

function composeSpeakText({ session, bodyText, callSid, firmConfig, llmAck = '', callerContext = 'neutral' }) {
  let trimmed = String(bodyText || '').trim();
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

  // (Fix B) On sensitive calls, strip any prohibited lead-in ack the LLM baked into its
  // line ("Okay, I have your details…") so distress/correction/question turns don't
  // open with a tone-deaf throwaway acknowledgment.
  const sensitiveTurn = session.isUrgent || session.hadCorrection || session.hadCallerQuestion
    || ['urgent_or_distressed', 'correction', 'caller_question'].includes(callerContext);
  if (sensitiveTurn) trimmed = stripLeadingProhibitedAck(trimmed) || trimmed;

  // LLM provided its own acknowledgment — next_question_text already has it baked in,
  // so return it directly instead of prepending a redundant deterministic ack.
  if (llmAck) return enrichForSpeech(trimmed);

  const ack = getNextAck(callSid || session.callSid, firmConfig, callerContext);
  return enrichForSpeech(ack ? `${ack} ${trimmed}` : trimmed);
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
  const hasSpeakText = !!(speakText && speakText.trim());
  const effectiveKey = ttsKey || (hasSpeakText ? null : holdKey);
  const speakerNode = effectiveKey
    ? `<Play>${xmlEscape(`${PUBLIC_BASE_URL}/api/tts?key=${encodeURIComponent(effectiveKey)}`)}</Play>`
    : liveUrl
      ? `<Play>${xmlEscape(liveUrl)}</Play>`
      : `<Say>${xmlEscape(speakText.replace(/<[^>]+>/g, ''))}</Say>`;
  const redirectUrl = addQueryParam(addQueryParam(actionUrl, 'empty', '1'), 'rc', Number(emptyCount) + 1);
  const hintsAttr = hints ? ` hints="${xmlEscape(hints)}"` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${xmlEscape(actionUrl)}" method="POST" speechTimeout="auto" timeout="6" actionOnEmptyResult="true" bargeIn="true" enhanced="true" language="en-US" profanityFilter="false"${hintsAttr}>
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
  const hasSpeakText = !!(speakText && speakText.trim());
  const effectiveKey = ttsKey || (hasSpeakText ? null : holdKey);
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
  <Gather input="speech" action="${xmlEscape(graceUrl)}" method="POST" speechTimeout="1" timeout="2" actionOnEmptyResult="true" bargeIn="false" enhanced="true" language="en-US" profanityFilter="false">
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

  const voiceSettings = getVoiceSettings();
  const key = makeTtsCacheKey({ voiceId: ELEVENLABS_VOICE_ID, modelId: ELEVENLABS_MODEL_ID, settings: voiceSettings, text: safeText });
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
          voice_settings: voiceSettings,
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

function isSandboxFromAddress(from) {
  return !from || /@resend\.dev$/i.test(String(from).trim());
}

async function resendPost({ from, to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    signal: AbortSignal.timeout(Number(process.env.RESEND_TIMEOUT_MS ?? 5000)),
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`Resend ${res.status}: ${text || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  try { return JSON.parse(text); } catch { return {}; }
}

// Central delivery: retries with exponential backoff, logs every outcome.
// Never throws — callers fire-and-forget safely.
async function sendEmailWithRetry({ leadId, firmId, to, subject, html }) {
  if (!RESEND_API_KEY) {
    app.log.warn({ leadId, to }, 'email-skip: RESEND_API_KEY not set');
    await logEmailAttempt({ leadId, firmId, to: to || '(none)', subject, status: 'failed', error: 'RESEND_API_KEY not set' }).catch(() => {});
    return { ok: false, error: 'no_api_key' };
  }
  if (!to) {
    app.log.warn({ leadId }, 'email-skip: no recipient');
    await logEmailAttempt({ leadId, firmId, to: '(none)', subject, status: 'failed', error: 'no recipient' }).catch(() => {});
    return { ok: false, error: 'no_recipient' };
  }
  const from = RESEND_FROM_EMAIL || 'onboarding@resend.dev';
  if (isSandboxFromAddress(from)) {
    app.log.warn({ leadId, to, from }, 'email-warn: RESEND_FROM_EMAIL is the Resend sandbox — deliveries to addresses other than the Resend account owner will be silently dropped. Set RESEND_FROM_EMAIL to an address on a verified domain.');
  }
  const delaysMs = [0, 1000, 4000];
  let lastErr;
  for (let i = 0; i < delaysMs.length; i++) {
    if (delaysMs[i]) await new Promise((r) => setTimeout(r, delaysMs[i]));
    try {
      const data = await resendPost({ from, to, subject, html });
      await logEmailAttempt({ leadId, firmId, to, subject, status: 'sent', resend_id: data.id }).catch((e) => app.log.warn({ err: String(e) }, 'email-log-insert-failed'));
      app.log.info({ id: data.id, leadId, to, attempt: i + 1 }, 'email-sent');
      return { ok: true, id: data.id };
    } catch (err) {
      lastErr = err;
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) break;
      app.log.warn({ err, leadId, to, attempt: i + 1 }, 'email-attempt-failed');
      console.error('[Email] Resend error:', err);
    }
  }
  await logEmailAttempt({ leadId, firmId, to, subject, status: 'failed', error: lastErr?.message || 'unknown' }).catch((e) => app.log.warn({ err: String(e) }, 'email-log-insert-failed'));
  app.log.error({ err: lastErr, leadId, to }, 'email-failed-after-retries');
  console.error('[Email] Resend error:', lastErr);
  return { ok: false, error: lastErr?.message };
}

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
  const notificationEmail = String(firmConfig?.notification_email || '').trim();
  if (!RESEND_API_KEY) {
    app.log.warn({ leadId: session.leadId }, 'sendEmailNotification: RESEND_API_KEY not set — skipping');
    console.warn('[Email] Skipping — RESEND_API_KEY not set');
    return;
  }
  if (!notificationEmail) {
    app.log.warn({ leadId: session.leadId, firmId: firmConfig?.id }, 'sendEmailNotification: no notification_email on firm — skipping');
    console.warn('[Email] Skipping — notification_email not set for firm:', firmConfig?.id);
    return;
  }
  app.log.info({ leadId: session.leadId, from: RESEND_FROM_EMAIL, to: notificationEmail }, 'sendEmailNotification: attempting send');

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

  await sendEmailWithRetry({
    leadId: session.leadId,
    firmId: session.firmId,
    to: notificationEmail,
    subject: `New lead — ${name} (${area})`,
    html,
  });
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

  await sendEmailWithRetry({
    leadId: session.leadId,
    firmId: session.firmId,
    to: firmConfig.notification_email,
    subject: `[Partial] Lead from ${name} (${area})`,
    html,
  });
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
            content: 'You are auditing an AI phone intake call for quality. Return strict JSON: { "naturalness": <int>, "completeness": <int>, "efficiency": <int>, "overall": <int>, "flags": [<string>] }. Score each 1-10. naturalness: 9-10 = acknowledges the caller every turn with varied phrasing; 5-6 = generic acknowledgments or some repetition; 1-3 = robotic or ignores the caller. completeness: 9-10 = name, working callback number, and a summary with WHAT and WHEN; 5-6 = one of those missing or vague; 1-3 = most missing. efficiency: 9-10 = every turn gathers something new; 5-6 = one or two wasted turns; 1-3 = loops or re-asks collected info. overall = your weighted judgment, not an average. flags: up to 3 short observations, each under 10 words (e.g. "re-asked collected name", "missed urgency cue", "closed without timing").',
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
            content: 'You are writing a call summary for the attorney who will follow up on this lead. In 2-3 plain sentences: who called (name, and new or returning client if known), what happened to them and roughly when, and what they want. Use the caller\'s own words for the key facts. If the caller was urgent or distressed, say so in the first sentence. Note anything missing the attorney should get on the callback (e.g. "callback number not confirmed"). Third person. No bullet points, no legal conclusions, no speculation beyond the transcript. Do not start with "The caller". Under 80 words.',
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

async function fireNotifications(session, firmConfig) {
  app.log.info(
    { leadId: session.leadId, done: session.done, hasResendKey: !!RESEND_API_KEY, notificationEmail: firmConfig?.notification_email || '' },
    'fireNotifications called',
  );
  if (!session.done) return;
  if (session.notified) {
    app.log.debug({ leadId: session.leadId }, 'notifications already sent — skipping');
    return;
  }
  session.notified = true; // close the latch before the first send is dispatched (race-safe)
  if (!RESEND_API_KEY) {
    app.log.warn({ leadId: session.leadId }, 'fireNotifications: RESEND_API_KEY not set — email notification will be skipped');
    console.warn('[Email] Skipping — RESEND_API_KEY not set');
  }
  try {
    await sendEmailNotification(session, firmConfig);
  } catch (err) {
    app.log.error({ err, leadId: session.leadId }, 'email notification unexpected failure');
    console.error('[Email] Resend error:', err);
  }
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

function isCallerQuestion(userText) {
  const text = String(userText || '').trim();
  return /\?$/.test(text) || /^(who|what|when|where|why|how|is|are|am|do|does|did|can|could|will|would|should)\b/i.test(text);
}

async function runNextStepController({ firmId, callSid, fromPhone, userText, speechConfidence = null, callerContext = classifyFillerContext(userText) }) {
  return withCallLock(callSid, async () => {
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
  session.lastSpeechConfidence = speechConfidence;

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
    await saveSessions(sessions);
    persistSessionArtifacts(session, { assistantText: exitText, callerText, done: true }).catch((err) => app.log.warn({ err: String(err), callSid }, 'early-exit persistArtifacts failed'));
    return { firmConfig, session, payload: { speakText: exitText, ttsKey, done: true, nextField: null, timings: {} } };
  }

  // Returning caller check — on first turn only (before caller type question is asked)
  if (!callerText && session.callerType === null) {
    const history = await lookupCallerHistory(normalizedPhone, firmConfig.id);
    if (history.isReturning) {
      session.callerType = 'returning';
      // Pre-populate captured fields so Ava doesn't re-ask — EXCEPT callback_number,
      // which is unverified for THIS call and must be explicitly confirmed (audit R3 /
      // Defect B). Stash the carried number for the confirmation prompt only.
      for (const [k, v] of Object.entries(history.capturedFields)) {
        if (k === 'callback_number') continue;
        if (v && !session.collected[k]) session.collected[k] = v;
      }
      if (history.capturedFields.callback_number) {
        session.carriedCallback = history.capturedFields.callback_number;
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

  const deterministicExtracted = extractAllFieldsFromLongResponse(callerText, session.lastQuestionId);

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
  if (llmPromise) {
    session.internalClarifyingNote = normalizeInternalClarifyingNote(llm?.clarifying_note);
  }
  const tAfterOpenAi = Date.now();
  if (llmPromise) app.log.info({ callSid, elapsedMs: tAfterOpenAi - tOpenAiStart }, 'openai-returned');
  // Merge: LLM values win, but only if non-empty — never let an LLM empty string
  // wipe out a good deterministic extraction (e.g. case_summary from long text).
  // Also, don't let a short LLM case_summary overwrite a good long deterministic one.
  const extracted = { ...deterministicExtracted };
  for (const [k, v] of Object.entries(llm?.extracted || {})) {
    if (v == null || String(v).trim() === '') continue;
    if (k === 'case_summary' && extracted[k] && !isLikelySummary(String(v).trim(), session.lastQuestionId)) continue;
    extracted[k] = v;
  }
  const expectedField = session.lastQuestionId;

  // ── Deterministic callback authority (Invariants 1,2,6) ──────────────────────
  // A phone number the caller actually spoke — direct, spoken-word, or mixed — is
  // parsed deterministically and OVERRIDES the non-deterministic LLM callback value.
  // Scope: an explicit correction, no callback collected yet, or a callback/retry
  // turn. This prevents the LLM from corrupting a valid number and prevents grabbing
  // stray numbers from unrelated turns. Precedence: correction > deterministic >
  // (carried, handled below) > validated LLM fallback > empty.
  const phoneCandidate = extractPhoneCandidate(callerText);
  const phoneCorrection = !!(phoneCandidate && callerText && detectPhoneCorrectionIntent(callerText));
  const hadCallback = !!String(session.collected.callback_number || '').trim();
  if (phoneCandidate && (phoneCorrection || !hadCallback || expectedField === 'callback_number' || expectedField === '__phone_retry__')) {
    extracted.callback_number = phoneCandidate.normalized;
    session.callbackProvenance = phoneCorrection ? 'explicit_correction' : phoneCandidate.provenance;
  } else if (hadCallback && !phoneCorrection) {
    // A callback is already collected and the caller did NOT speak a new number
    // (or a correction) this turn — the LLM must never re-invent/mutate an
    // established callback from conversational context. Drop any LLM candidate so
    // mergeExtracted leaves the collected number untouched.
    delete extracted.callback_number;
  } else if (session.carriedCallback && callerText && isAffirmative(callerText)) {
    // Returning caller affirming the on-file number — the carried-number confirmation
    // path below is authoritative; the LLM must not inject a different number here.
    delete extracted.callback_number;
  } else if (!hadCallback && String(extracted.callback_number || '').trim()) {
    // "validated-LLM" tier. By this point phoneCandidate is null — any number
    // the deterministic parser could read would have been taken above — so the
    // LLM has proposed a callback the parser did NOT find. Only trust it when the
    // caller's utterance actually carries those digits; otherwise it is a
    // hallucination (on a pure affirmation like "yes, that number is fine" the
    // model copies the E.164 example straight out of its own extraction prompt).
    // Dropping an uncorroborated number keeps the callback gate asking rather
    // than saving one the caller never spoke.
    const utteranceDigits = String(spokenToDigits(callerText).digits || '');
    const llmDigits = String(extracted.callback_number).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (utteranceDigits && llmDigits && utteranceDigits.includes(llmDigits) && isLikelyPhone(extracted.callback_number)) {
      session.callbackProvenance = 'llm_fallback';
    } else {
      delete extracted.callback_number;
    }
  }

  const lowConfidence = isLowSpeechConfidence(speechConfidence);
  const lowConfidenceExactField = lowConfidence && ['full_name', 'callback_number'].includes(expectedField)
    ? expectedField
    : null;
  const exactFieldUpdateBlocked = !!(lowConfidenceExactField && String(extracted[lowConfidenceExactField] || '').trim());
  if (lowConfidenceExactField) delete extracted[lowConfidenceExactField];
  app.log.info({
    callSid,
    speechConfidence,
    threshold: STT_LOW_CONFIDENCE_THRESHOLD,
    expectedField,
    exactFieldUpdateBlocked,
  }, 'stt-confidence');
  const fieldUpdates = mergeExtracted(session, extracted, callerText, firmConfig);
  let callbackCollectedThisTurn = !!fieldUpdates.callback_number;

  // Explicit correction is authoritative even when Ava's current question concerns
  // another field (Invariant 4): replace the stored number and clear retry state.
  if (phoneCorrection) {
    session.collected.callback_number = phoneCandidate.normalized;
    session.phoneRetryPending = false;
    callbackCollectedThisTurn = true;
  }
  if (callbackCollectedThisTurn) {
    app.log.info({ callSid, callbackProvenance: session.callbackProvenance || 'unknown' }, 'callback-collected');
  }

  // ── Urgency detection (Fix C) ──────────────────────────────────────────────
  if (!session.isUrgent && callerText) {
    const urg = classifyUrgency(callerText);
    if (urg.urgent) {
      session.isUrgent = true;
      session.urgencyCategory = urg.category;
      app.log.info({ callSid, urgencyCategory: urg.category, signals: urg.signals, confidence: urg.confidence }, 'urgency-detected');
      // The urgency statement ("I was in a car accident and I'm scared") may have been
      // auto-extracted as case_summary by extractStructuredDeterministic (≥40 chars, ≥4 words).
      // That's NOT a real case summary — it's just the distress signal.
      // Clear it so Ava explicitly asks for a case summary on a later turn instead of jumping to done.
      if (!session.askedQuestionIds.includes('case_summary')) {
        delete session.collected.case_summary;
      }
    }
  }

  // ── Closing-context signals (Fix B) + refusal tracking (Fix D/G) ────────────
  if (callerText) {
    if (phoneCorrection || detectNameCorrectionIntent(callerText) || classifyFillerContext(callerText) === 'correction') {
      session.hadCorrection = true;
    }
    if (isCallerQuestion(callerText)) session.hadCallerQuestion = true;
    // Explicit refusal of the field Ava is currently asking for: record it so the
    // gate stops re-asking after one polite retry instead of looping (Fix D/G).
    if (detectRefusal(callerText)) {
      const f = session.lastQuestionId === '__phone_retry__' ? 'callback_number' : session.lastQuestionId;
      if (f && f !== 'final_clarify' && f !== '__caller_type__') {
        // Defensive init — sessions persisted before this field existed lack it.
        if (!session.refusalCounts) session.refusalCounts = {};
        session.refusalCounts[f] = (session.refusalCounts[f] || 0) + 1;
        if (session.refusalCounts[f] >= 1) session.refusedField = f;
        session.phoneRetryPending = false;
      }
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
            callbackCollectedThisTurn = true;
          }
        }
      }
    } else if (session.lastQuestionId === 'callback_number') {
      // Normal phone turn: if caller gave digits but extraction failed, schedule a retry
      const digits = callerText.replace(/\D/g, '');
      if (digits.length >= 7 && !fieldUpdates.callback_number && lowConfidenceExactField !== 'callback_number') {
        session.phoneRetryPending = true;
      }
    }
  }

  // Returning-caller callback confirmation (audit R3 / Defect B): when Ava asked the
  // caller to confirm the on-file number and they affirm (without speaking a new one),
  // promote the carried value into collected. A refusal / non-answer leaves it empty,
  // so the gate keeps asking rather than saving an unverified number.
  if (session.carriedCallback
      && session.lastQuestionId === 'callback_number'
      && callerText
      && !String(session.collected.callback_number || '').trim()
      && !fieldUpdates.callback_number
      && isAffirmative(callerText)) {
    session.collected.callback_number = session.carriedCallback;
    session.callbackProvenance = 'carried_number';
    callbackCollectedThisTurn = true;
  }

  if (callbackCollectedThisTurn || String(session.collected.callback_number || '').trim()) {
    session.phoneRetryPending = false;
  }

  const maxQ = firmConfig.max_questions || 8;
  const reachedQuestionCap = session.turnCount >= maxQ;
  const requiredFields = effectiveConfig.required_fields || REQUIRED_FIELDS_DEFAULT;
  // A required field counts as resolved-for-completion when collected OR explicitly
  // refused — so a caller who declines to give a field completes the intake gracefully
  // instead of being asked the same question until the hard cap (Fix D/G).
  const isFieldSatisfied = (f) => !!String(session.collected[f] || '').trim() || session.refusedField === f;
  const allCollected = requiredFields.every(isFieldSatisfied);

  // Recompute after mergeExtracted so nextDecision reflects the updated collected fields.
  // The speculative decision above may be stale if extraction filled a previously missing field.
  let nextDecision = buildDeterministicQuestion(session, effectiveConfig);
  if (!allCollected && !reachedQuestionCap && llm) {
    const nextId = String(llm.next_question_id || '').trim();
    const nextText = String(llm.next_question_text || '').trim();
    // Exclude a refused field so the LLM can't re-propose it (Fix D).
    const missing = requiredFields.filter((field) => !isFieldSatisfied(field));
    if (nextId && nextText && !session.askedQuestionIds.includes(nextId) && missing.includes(nextId) && missing.length) {
      // 5.2 — field-repeat guard: skip if already collected
      if (session.collected[nextId] && String(session.collected[nextId]).trim()) {
        // already collected — let deterministic fallback pick the next missing field
      } else {
        nextDecision = { done: false, nextField: missing[0], nextQuestionId: nextId, nextQuestionText: nextText };
      }
    }
  }
  if (lowConfidenceExactField) {
    nextDecision = {
      done: false,
      nextField: lowConfidenceExactField,
      nextQuestionId: lowConfidenceExactField,
      nextQuestionText: exactFieldClarification(lowConfidenceExactField),
    };
  }

  // Require both GPT agreement and core fields before allowing hangup.
  // If LLM is available and returned a non-"done" next_question_id, keep going
  // even if fields appear collected — GPT may know the caller isn't actually done.
  // The question cap remains a hard ceiling regardless.
  const llmWantsContinue = llm && String(llm.next_question_id || '').trim() !== 'done';
  // callback_number must be explicitly collected (not just inferred from caller ID)
  // to count as present for the done check.
  const corePresentOrRefused = (f) => String(session.collected[f] || '').trim().length >= 2 || session.refusedField === f;
  const allCorePresent = ['full_name', 'case_summary'].every(corePresentOrRefused)
    && corePresentOrRefused('callback_number');
  // Hard cap: allow up to 4 extra turns if core fields aren't collected yet.
  // This prevents hanging up on a caller who never gave their name or number.
  const hardCap = reachedQuestionCap && (allCorePresent || session.turnCount >= (maxQ + 4));
  const done = hardCap
    || (allCorePresent && !llmWantsContinue && (allCollected || nextDecision.done))
    // Caller refused a field and everything else is collected — complete gracefully
    // even if the LLM would keep probing, so we don't loop on the refused field (Fix G).
    || (!!session.refusedField && allCorePresent && nextDecision.done);

  // ── Gate/generator divergence interceptor (audit R3) ───────────────────────
  // If the done-gate says NOT done but the deterministic generator has exhausted
  // its questions (returns its {done:true, nextQuestionId:null} sentinel), do NOT
  // let that null sentinel flow into session.lastQuestionId — that poisons the
  // /twiml first-turn routing and fires the C2 empty-speakText guard. Instead
  // synthesize a concrete question for the first core field the gate still wants.
  if (!done && nextDecision.done === true) {
    const coreFields = ['full_name', 'case_summary', 'callback_number'];
    const missingCore = coreFields.filter(
      (f) => String(session.collected[f] || '').trim().length < 2 && session.refusedField !== f,
    );
    const targetField = missingCore[0] || 'final_clarify';
    const overrideText = getQuestionText(targetField, effectiveConfig);
    const fallbackText =
      targetField === 'callback_number' ? "I just need one more thing — what's the best number to reach you?"
      : targetField === 'full_name'     ? "Before I let you go — can I get your name?"
      : targetField === 'case_summary'  ? "And briefly, what's the reason for your call today?"
      : "One last thing — anything else the attorney should know?";
    nextDecision = {
      done: false,
      nextField: targetField,
      nextQuestionId: targetField,
      nextQuestionText: overrideText || fallbackText,
    };
    app.log.warn(
      {
        tag: 'GATE_GENERATOR_DIVERGENCE',
        callSid,
        missingField: targetField,
        missingCore,
        collectedKeys: Object.keys(session.collected),
        caller_type: session.callerType,
        turnCount: session.turnCount,
      },
      'gate/generator divergence — synthesizing question for unsatisfied core field',
    );
  }

  let speakText = effectiveConfig.closing || DEFAULT_FIRM_CONFIG.closing;
  let nextField = null;
  // llmAck is no longer a separate field — acknowledgment is baked into next_question_text
  const llmAck = '';

  if (!done) {
    // EDIT 4 (audit R45) — never advance turn state on a null question id. Post-EDIT-1
    // this always holds; kept as a seatbelt against a null sentinel reaching this branch
    // (this codebase's history is fallback values quietly masking invariant violations).
    if (nextDecision.nextQuestionId != null) {
      session.turnCount += 1;
      session.lastQuestionId = nextDecision.nextQuestionId;
      session.lastQuestionText = nextDecision.nextQuestionText;
      session.askedQuestionIds.push(nextDecision.nextQuestionId);
    }
    nextField = nextDecision.nextField;

    // LLM's next_question_text has the emotional ack baked in per system prompt — use it directly.
    // Fall back to deterministic question only if LLM didn't return one.
    const llmQuestionText = String(llm?.next_question_text || '').trim();
    let questionBody = llmQuestionText || nextDecision.nextQuestionText;

    // If the LLM didn't return a separate acknowledgment but baked one into next_question_text
    // (as the system prompt allows), treat it as having an ack to prevent composeSpeakText
    // from prepending a redundant deterministic ack.
    // If the LLM returned any text, trust it — the system prompt requires it to bake in an ack.
    // Never prepend a deterministic ack on top of LLM-generated speech.
    const effectiveLlmAck = llmAck || (llmQuestionText ? '_baked_in_' : '');
    speakText = composeSpeakText({ session, bodyText: questionBody, callSid, firmConfig: effectiveConfig, llmAck: effectiveLlmAck, callerContext });
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
    // (Fix B) Context-aware closing: sensitive / refusal / correction closings never
    // claim "everything I need" and never lead with a prohibited acknowledgment.
    speakText = selectClosing(session, effectiveConfig);
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

  // C2 — guard against empty speakText. Do NOT force-close (audit R36): an empty
  // speakText is a phrasing bug, not a completed intake. Reprompt the last question
  // (or a clarifier) and keep the line open so the caller isn't hung up mid-intake.
  if (!speakText || !speakText.trim()) {
    app.log.error({ callSid, done, nextDecision }, 'speakText was empty — reprompting instead of closing');
    speakText = (session.lastQuestionText && session.lastQuestionText.trim())
      || getQuestionText('final_clarify', effectiveConfig)
      || 'Sorry — could you say that again?';
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

  // Persist session state before returning so follow-up routes can read their writes.
  await saveSessions(sessions);
  persistSessionArtifacts(session, { assistantText: speakText, callerText, done: session.done })
    .then(() => { if (session.done) app.log.info({ callSid, leadId: session.leadId }, 'persistArtifacts OK — lead saved to DB'); })
    .catch((err) => app.log.error({ err: String(err), callSid, leadId: session.leadId }, 'persistArtifacts FAILED — lead not saved'));
  app.log.info({ leadId: session.leadId, sessionDone: session.done, firmId: session.firmId, notificationEmailFromConfig: firmConfig?.notification_email || '(empty)' }, 'about to call fireNotifications');
  fireNotifications(session, firmConfig).catch(err => app.log.error({ err: String(err) }, 'fireNotifications background failure'));

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
  });
}

function applyRepromptText(session, firmConfig) {
  const maxReprompts = firmConfig?.max_reprompts || 2;
  if (session.repromptCount >= maxReprompts) {
    session.done = true;
    // (Fix B) Use the context-aware, ack-sanitized closing here too.
    const closing = selectClosing(session, firmConfig || DEFAULT_FIRM_CONFIG);
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
  if ((!firmId || firmId === '') && !isAdmin) return reply.code(400).send({ error: 'firmId required and must be non-empty' });
  const leads = await loadLeads(firmId || undefined);
  leads.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  reply.header('Cache-Control', 'no-store, must-revalidate');
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

// Key-guarded lead feed for the front-desk dashboard. Returns PII (names, phone
// numbers, transcripts): admin key required on every request. Single-admin
// until the Cluster F auth layer lands.
app.get('/api/dashboard-leads', async (req, reply) => {
  if (!ADMIN_API_KEY) {
    app.log.warn('dashboard-leads: ADMIN_API_KEY not configured — refusing to serve PII');
    return reply.code(503).send({ error: 'admin key not configured' });
  }
  const provided = req.headers?.['x-admin-key'] || '';
  if (provided !== ADMIN_API_KEY) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const firmId = String(req.query?.firmId || 'firm_default').trim() || 'firm_default';
  let timer;
  try {
    // Bound the DB read so a stalled query fails fast+logged instead of hanging
    // the request until the edge returns a silent 502.
    const leads = await Promise.race([
      listLeadsForDashboard(firmId, 100),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('dashboard-leads db read timed out')),
          Number(process.env.DASHBOARD_DB_TIMEOUT_MS ?? 8000),
        );
      }),
    ]);
    clearTimeout(timer);
    reply.header('Cache-Control', 'no-store, must-revalidate');
    return reply.send({ firmId, leads });
  } catch (err) {
    clearTimeout(timer);
    app.log.error({ err: String(err), firmId }, 'dashboard-leads: failed to load leads');
    return reply.code(500).send({ error: 'failed to load leads' });
  }
});

// GET /dashboard — serves the static front-desk page. The page is inert without
// the admin key (the data endpoint above is what's guarded), so no auth here.
app.get('/dashboard', async (req, reply) => {
  try {
    const html = await fs.readFile(path.join(__dirname, 'dashboard.html'), 'utf8');
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(html);
  } catch (err) {
    app.log.error({ err: String(err) }, 'dashboard: failed to read dashboard.html');
    return reply.code(500).send('dashboard unavailable');
  }
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
  const voiceSettings = getVoiceSettings();
  const key = makeTtsCacheKey({ voiceId: ELEVENLABS_VOICE_ID, modelId: ELEVENLABS_MODEL_ID, settings: voiceSettings, text: safeText });
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
          voice_settings: voiceSettings,
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

app.post('/twiml', { preHandler: twilioSignaturePreHandler }, async (req, reply) => {
  const tTwimlStart = Date.now();
  const callSid = String(req.body?.CallSid || '').trim();
  const fromPhone = normalizePhone(req.body?.From);
  const userText = String(req.body?.SpeechResult || '').trim();
  const speechConfidence = parseSpeechConfidence(req.body?.Confidence);
  const callerContext = classifyFillerContext(userText);
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

    // EDIT 6 (audit R36) — if this session already completed, do not re-run the
    // controller. A stray empty-SpeechResult POST (Gather actionOnEmptyResult,
    // webhook retry) on a done session must not re-enter first-turn logic and
    // produce a duplicate goodbye. Speak the closing once and hang up.
    if (session.done === true) {
      const closing = firmConfig.closing || DEFAULT_FIRM_CONFIG.closing;
      const closeKey = await synthesizeToDisk(closing).catch(() => null);
      reply.header('Content-Type', 'text/xml');
      return reply.send(doneTwiml({ speakText: closing, ttsKey: closeKey }));
    }

    let speakText = '';
    let done = false;
    let ttsKey = null;

    if (!userText) {
      if (session.turnCount === 0) {
        // First turn — controller handles TTS prefetch internally
        const firstStep = await runNextStepController({ firmId, callSid, fromPhone, userText: '', speechConfidence, callerContext });
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
        await saveSessions(sessions);
        persistSessionArtifacts(session, { assistantText: speakText, callerText: '', done })
          .catch((err) => app.log.warn({ err: String(err), callSid }, 'persistArtifacts failed'));
        app.log.info({ leadId: session.leadId, sessionDone: session.done, firmId: session.firmId, notificationEmailFromConfig: firmConfig?.notification_email || '(empty)' }, 'about to call fireNotifications');
        await fireNotifications(session, firmConfig);
        ttsKey = await ttsPromise;
      }
    } else {
      // C3 — duplicate controller guard: if a controller is already pending, replay filler + redirect
      if (pendingResponses.has(callSid)) {
        app.log.warn({ callSid }, '/twiml: duplicate request while controller pending — replaying filler');
        const selectedDup = selectThinkingFiller(userText, fillerLastIdxMap.get(callSid) ?? -1, callerContext);
        if (selectedDup.fillerIdx != null) fillerLastIdxMap.set(callSid, selectedDup.fillerIdx);
        const fillerKeyDup = selectedDup.category === 'caller_question'
          ? questionFillerKey
          : selectedDup.category === 'correction'
            ? correctionFillerKey
            : selectedDup.fillerIdx != null
              ? fillerKeys[selectedDup.fillerIdx]
              : null;
        const fillerAudioUrlDup = selectedDup.text && fillerKeyDup
          ? `${PUBLIC_BASE_URL}/api/tts?key=${encodeURIComponent(fillerKeyDup)}`
          : null;
        const resultUrlDup = `${PUBLIC_BASE_URL}/twiml-result?callSid=${encodeURIComponent(callSid)}&firmId=${encodeURIComponent(firmId)}`;
        reply.header('Content-Type', 'text/xml');
        return reply.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${fillerAudioUrlDup ? `<Play>${xmlEscape(fillerAudioUrlDup)}</Play>` : ''}
  <Redirect method="POST">${xmlEscape(resultUrlDup)}</Redirect>
</Response>`);
      }

      // Normal turn — start processing in background, then only play filler if OpenAI is slow
      const processingPromise = runNextStepController({ firmId, callSid, fromPhone, userText, speechConfidence, callerContext });
      const pending = { promise: processingPromise, t0 };
      pendingResponses.set(callSid, pending);

      const winner = await Promise.race([
        pending.promise.then(() => 'ready', () => 'slow'),
        new Promise(r => setTimeout(() => r('slow'), FILLER_GATE_MS)),
      ]);

      if (winner === 'ready') {
        let step;
        try {
          step = await pending.promise;
        } finally {
          pendingResponses.delete(callSid);
        }
        reply.header('Content-Type', 'text/xml');
        return reply.send(buildPendingResultTwiml({ step, pending, firmId, callSid }));
      }

      const selectedFiller = selectThinkingFiller(userText, fillerLastIdxMap.get(callSid) ?? -1, callerContext);
      app.log.info({ callSid, fillerCategory: selectedFiller.category, fillerSuppressed: !selectedFiller.text }, 'filler-selected');

      if (selectedFiller.fillerIdx != null) fillerLastIdxMap.set(callSid, selectedFiller.fillerIdx);
      const fillerKey = selectedFiller.category === 'caller_question'
        ? questionFillerKey
        : selectedFiller.category === 'correction'
          ? correctionFillerKey
          : selectedFiller.fillerIdx != null
            ? fillerKeys[selectedFiller.fillerIdx]
            : null;
      const staticFillerAudioUrl = selectedFiller.text && fillerKey
        ? `${PUBLIC_BASE_URL}/api/tts?key=${encodeURIComponent(fillerKey)}`
        : null;

      const fillerAudioUrl = staticFillerAudioUrl;

      const resultUrl = `${PUBLIC_BASE_URL}/twiml-result?callSid=${encodeURIComponent(callSid)}&firmId=${encodeURIComponent(firmId)}`;

      app.log.info({ callSid, fillerIdx: selectedFiller.fillerIdx, fillerCached: !!fillerKey, fillerCategory: selectedFiller.category, fillerSuppressed: !fillerAudioUrl }, 'filler-sent');
      reply.header('Content-Type', 'text/xml');
      return reply.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${fillerAudioUrl ? `<Play>${xmlEscape(fillerAudioUrl)}</Play>` : ''}
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
function buildPendingResultTwiml({ step, pending, firmId, callSid }) {
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

  if (done) return doneTwiml({ speakText, ttsKey, liveUrl, firmId, callSid });

  const practiceHints = (step.firmConfig.practice_areas || []).join(', ');
  return gatherTwiml({
    actionUrl: `${PUBLIC_BASE_URL}/twiml?firmId=${encodeURIComponent(firmId)}`,
    speakText,
    ttsKey,
    liveUrl,
    emptyCount: step.session.repromptCount,
    hints: practiceHints,
  });
}

app.post('/twiml-result', { preHandler: twilioSignaturePreHandler }, async (req, reply) => {
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
    return reply.send(buildPendingResultTwiml({ step, pending, firmId, callSid }));
  } catch (err) {
    app.log.error({ err: String(err), stack: err?.stack, callSid }, '/twiml-result failed');
    return reply.send(doneTwiml({ speakText: getErrorMessage(), ttsKey: null }));
  }
});

// POST /twiml-grace — grace period after Ava's closing line.
// Twilio holds the line for 4 seconds and POSTs here whether or not the caller speaks.
// Speech → un-done the session and continue. Silence → hang up.
app.post('/twiml-grace', { preHandler: twilioSignaturePreHandler }, async (req, reply) => {
  const callSid = String(req.body?.CallSid || req.query?.callSid || '').trim();
  const firmId = String(req.query?.firmId || 'firm_default').trim();
  const speech = String(req.body?.SpeechResult || '').trim();
  const speechConfidence = parseSpeechConfidence(req.body?.Confidence);
  const callerContext = classifyFillerContext(speech);

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
    const result = await runNextStepController({ firmId, callSid, fromPhone, userText: speech, speechConfidence, callerContext });
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
app.post('/call-status', { preHandler: twilioSignaturePreHandler }, async (req, reply) => {
  const callSid = String(req.body?.CallSid || '').trim();
  const callStatus = String(req.body?.CallStatus || '').trim();
  const callDuration = parseInt(req.body?.CallDuration || '0', 10);

  if (callStatus !== 'completed' || !callSid) return reply.code(204).send();

  // Acknowledge Twilio immediately — never let Twilio time out waiting on our DB writes.
  reply.code(204).send();

  withCallLock(callSid, async () => {
    // Reload session inside the lock so we see the final state after any in-flight /twiml turn.
    const sessions = await loadSessions();
    const session = sessions[callSid];
    if (!session) return;

    // Duration patch is now inside the lock — can't race persistSessionArtifacts.
    if (callDuration > 0 && session.leadId) {
      try {
        await patchLead(session.leadId, { call_duration_seconds: callDuration });
      } catch (err) {
        app.log.warn({ err: String(err), callSid }, 'call-status: duration patch failed');
      }
    }

    // Session already marked done — full lead already saved by the last /twiml turn, just clean up.
    if (session.done === true) {
      await persistSessionArtifactsUnlocked(session, { assistantText: '', callerText: '', done: true });
      await deleteSession(callSid).catch((err) => app.log.warn({ err: String(err), callSid }, 'call-status: session delete failed'));
      return;
    }

    // Caller hung up before intake completed — persist as partial lead.
    app.log.info({ callSid, leadId: session.leadId, callDuration }, 'call-status: saving partial lead');
    try {
      await persistSessionArtifactsUnlocked(session, { assistantText: '', callerText: '', done: false });
      await patchLead(session.leadId, { status: 'partial' });
      const firmConfig = await loadFirmConfig(session.firmId || 'firm_default');
      const partialLead = { id: session.leadId, firmId: session.firmId, fromPhone: session.fromPhone, status: 'partial', ...session.collected };
      sendPartialEmailNotification(session, firmConfig)
        .catch((err) => app.log.warn({ err: String(err), leadId: session.leadId }, 'partial email unexpected failure'));
      fireWebhooks(partialLead, session.firmId, firmConfig);
    } catch (err) {
      app.log.warn({ err: String(err), callSid }, 'call-status: partial lead save failed');
    }

    await deleteSession(callSid).catch((err) => app.log.warn({ err: String(err), callSid }, 'call-status: session delete failed'));
  }).catch((err) => app.log.error({ err: String(err), callSid }, 'call-status: lock body failed'));
});

// POST /recording-status — Twilio recording status callback; saves recording URL to lead
app.post('/recording-status', { preHandler: twilioSignaturePreHandler }, async (req, reply) => {
  const callSid = String(req.body?.CallSid || '').trim();
  const recordingUrl = String(req.body?.RecordingUrl || '').trim();
  const duration = parseInt(req.body?.RecordingDuration || '0', 10);

  if (!callSid || !recordingUrl) return reply.code(204).send();

  reply.code(204).send();

  withCallLock(callSid, async () => {
    const sessions = await loadSessions();
    const session = sessions[callSid];
    if (session?.leadId) {
      await patchLead(session.leadId, { recording_url: recordingUrl, recording_duration: duration });
      app.log.info({ callSid, leadId: session.leadId, duration }, 'recording-saved');
    } else {
      const call = await getCallByCallSid(callSid).catch(() => null);
      if (call?.leadId) {
        await patchLead(call.leadId, { recording_url: recordingUrl, recording_duration: duration });
        app.log.info({ callSid, leadId: call.leadId }, 'recording-status: saved via calls-table fallback (session already deleted)');
      } else {
        app.log.warn({ callSid }, 'recording-status: no session and no call row — recording_url dropped');
      }
    }
  }).catch((err) => app.log.warn({ err: String(err), callSid }, 'recording-status handler failed'));
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
app.post('/voicemail-recording', { preHandler: twilioSignaturePreHandler }, async (req, reply) => {
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

if (isMain) {
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

    // Batch to respect ElevenLabs 10-concurrent-request limit — prevents 429 storm on every deploy
    fillerKeys = new Array(FILLER_PREWARM_PHRASES.length);
    const FILLER_BATCH = 8;
    for (let i = 0; i < FILLER_PREWARM_PHRASES.length; i += FILLER_BATCH) {
      const batch = FILLER_PREWARM_PHRASES.slice(i, i + FILLER_BATCH);
      const results = await Promise.all(batch.map((p) => synthesizeToDisk(p).catch(() => null)));
      for (let j = 0; j < results.length; j++) fillerKeys[i + j] = results[j];
      if (i + FILLER_BATCH < FILLER_PREWARM_PHRASES.length) await new Promise((r) => setTimeout(r, 500));
    }
    questionFillerKey = fillerKeys[FILLER_PHRASES.length] || null;
    correctionFillerKey = fillerKeys[FILLER_PHRASES.length + 1] || null;
    const fillerReady = fillerKeys.filter(Boolean).length;
    console.log(`filler-phrases ready: ${fillerReady}/${FILLER_PREWARM_PHRASES.length}`);

    prewarmTtsCache().catch((err) => app.log.warn({ err: String(err) }, 'TTS prewarm error'));
  } catch (err) {
    app.log.error({ err: String(err) }, 'Server failed to start');
    process.exit(1);
  }
}

export {
  app,
  extractPhoneCandidate, detectPhoneCorrectionIntent, spokenToDigits,
  classifyNameCandidate, isLikelyName, detectNameCorrectionIntent,
  classifyUrgency, detectUrgency,
  detectEarlyExit, detectRefusal,
  isLikelySummary, isCallerQuestion,
  stripLeadingProhibitedAck, selectClosing,
};
