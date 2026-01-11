import 'dotenv/config';
import Fastify from 'fastify';
import formbody from '@fastify/formbody';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fetch = globalThis.fetch;

if (!fetch) {
  throw new Error('This project requires Node 18+ (global fetch).');
}

/* =========================
   CONFIG
========================= */
const PORT = Number(process.env.PORT || 5050);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

if (!PUBLIC_BASE_URL) throw new Error('❌ PUBLIC_BASE_URL missing');
if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
  throw new Error('❌ ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID missing');
}

const SERVER_PATH = fileURLToPath(import.meta.url);

const app = Fastify({ logger: true });
await app.register(formbody);

/* =========================
   FILE STORAGE (NO NATIVE DEPS)
========================= */
const DATA_DIR = path.resolve('data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TTS_CACHE_FILE = path.join(DATA_DIR, 'tts_cache.json');

await fs.mkdir(DATA_DIR, { recursive: true });

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

async function loadAll() {
  const data = await readJson(DB_FILE, { callers: {} });
  if (!data.callers) data.callers = {};
  return data;
}

async function saveAll(db) {
  await writeJsonAtomic(DB_FILE, db);
}

function normalizeRecord(caller, record) {
  const base = {
    caller,
    name: '',
    callback: '',
    best_time: '',
    category: 'other',
    answers: {},
    summary: '',
    status: 'new',
    internal_notes: '',
    history: [],
    updated_at: Date.now(),
    turn_count: 0,
    stage: 'greet',
    last_question_id: ''
  };

  const out = { ...base, ...(record || {}) };
  if (!out.answers) out.answers = {};
  if (!Array.isArray(out.history)) out.history = [];
  if (!out.status) out.status = 'new';
  if (!out.category) out.category = 'other';
  return out;
}

async function getCaller(caller) {
  const db = await loadAll();
  const found = db.callers[caller];
  return found ? normalizeRecord(caller, found) : null;
}

async function getOrCreateCaller(caller) {
  const db = await loadAll();
  const record = normalizeRecord(caller, db.callers[caller]);
  db.callers[caller] = record;
  await saveAll(db);
  return record;
}

async function upsertCaller(record) {
  const db = await loadAll();
  db.callers[record.caller] = normalizeRecord(record.caller, record);
  await saveAll(db);
  return db.callers[record.caller];
}

async function updateCaller(caller, patch) {
  const db = await loadAll();
  const current = normalizeRecord(caller, db.callers[caller]);
  const next = { ...current, ...patch, caller };
  db.callers[caller] = normalizeRecord(caller, next);
  await saveAll(db);
  return db.callers[caller];
}

async function loadTtsCache() {
  return readJson(TTS_CACHE_FILE, {});
}

async function saveTtsCache(cache) {
  await writeJsonAtomic(TTS_CACHE_FILE, cache);
}

/* =========================
   HELPERS
========================= */
const MAX_TURNS = 6;

const CATEGORY_OPTIONS = ['family', 'injury', 'criminal', 'business', 'other'];

const QUESTION_SETS = {
  universal: [
    {
      id: 'name_callback',
      label: 'Name + Callback Number',
      ask: 'I’m Ava, the assistant for Attorney Harper. He’s unavailable; I’ll take a message. What is your full name and the best callback number?'
    },
    {
      id: 'best_time_location',
      label: 'Best Time + Location',
      ask: 'What is the best time to reach you, and what state are you in?'
    },
    {
      id: 'category_description',
      label: 'Category + Brief Description',
      ask: 'Which type of matter is this—family, injury, criminal, or business—and what happened in a sentence or two?'
    }
  ],
  family: [
    { id: 'family_dates', label: 'Key Dates', ask: 'What are the key dates or deadlines involved?' },
    { id: 'family_children', label: 'Children', ask: 'Are children involved, and if so, what ages?' },
    { id: 'family_orders', label: 'Existing Orders', ask: 'Are there any existing court orders we should know about?' },
    { id: 'family_location', label: 'County', ask: 'Which county is the case in or expected to be filed?' },
    { id: 'family_conflict', label: 'Other Party', ask: 'Who is the other party involved?' },
    { id: 'family_goals', label: 'Goals', ask: 'What outcome are you hoping for?' }
  ],
  injury: [
    { id: 'injury_date', label: 'Injury Date', ask: 'What date did the injury occur?' },
    { id: 'injury_employer', label: 'Employer', ask: 'Who is the employer or responsible party?' },
    { id: 'injury_treatment', label: 'Treatment', ask: 'Have you received medical treatment yet?' },
    { id: 'injury_reported', label: 'Reported', ask: 'Was the injury reported, and if so, to whom?' },
    { id: 'injury_witnesses', label: 'Witnesses', ask: 'Were there any witnesses?' },
    { id: 'injury_deadlines', label: 'Deadlines', ask: 'Are there any upcoming hearings or deadlines?' }
  ],
  criminal: [
    { id: 'criminal_charge', label: 'Charge Type', ask: 'What is the charge or alleged offense?' },
    { id: 'criminal_court_date', label: 'Court Date', ask: 'Do you have an upcoming court date?' },
    { id: 'criminal_custody', label: 'Custody Status', ask: 'Are you currently in custody or out on bond?' },
    { id: 'criminal_rep', label: 'Current Representation', ask: 'Do you already have an attorney on this case?' },
    { id: 'criminal_county', label: 'County', ask: 'Which county is the case in?' },
    { id: 'criminal_prior', label: 'Prior History', ask: 'Is there any prior history the attorney should know about?' }
  ],
  business: [
    { id: 'business_parties', label: 'Parties', ask: 'Who are the parties involved?' },
    { id: 'business_signed', label: 'Documents', ask: 'What was signed or agreed to, if anything?' },
    { id: 'business_dates', label: 'Key Dates', ask: 'What are the key dates in dispute?' },
    { id: 'business_amount', label: 'Amount', ask: 'What is the approximate amount at stake?' },
    { id: 'business_outcome', label: 'Outcome', ask: 'What outcome are you hoping to achieve?' },
    { id: 'business_location', label: 'Location', ask: 'Where did this occur or which state’s law applies?' }
  ],
  other: [
    { id: 'other_context', label: 'Context', ask: 'Can you briefly describe the situation?' },
    { id: 'other_deadlines', label: 'Deadlines', ask: 'Are there any deadlines or court dates?' },
    { id: 'other_parties', label: 'Parties', ask: 'Who else is involved?' },
    { id: 'other_location', label: 'Location', ask: 'Where is this taking place?' },
    { id: 'other_documents', label: 'Documents', ask: 'Do you have any documents or evidence to share?' },
    { id: 'other_goal', label: 'Goal', ask: 'What outcome are you hoping for?' }
  ]
};

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeCaller(raw) {
  return (raw || 'unknown').toString().trim() || 'unknown';
}

function detectCategory(text, current) {
  const t = String(text || '').toLowerCase();
  if (t.includes('divorce') || t.includes('custody') || t.includes('family')) return 'family';
  if (t.includes('injury') || t.includes('worker') || t.includes('accident')) return 'injury';
  if (t.includes('criminal') || t.includes('charge') || t.includes('arrest')) return 'criminal';
  if (t.includes('contract') || t.includes('business') || t.includes('company')) return 'business';
  return current || 'other';
}

function extractPhone(text) {
  const match = String(text || '').match(/(\+?\d[\d\-\s().]{8,}\d)/);
  return match ? match[1].replace(/[^\d+]/g, '') : '';
}

function extractName(text) {
  const t = String(text || '').trim();
  const match = t.match(/(?:my name is|this is)\s+([A-Za-z.'\-\s]{2,})/i);
  if (match) return match[1].trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 4) return t;
  return '';
}

function buildSummary(record) {
  const parts = [];
  if (record.name) parts.push(`Caller ${record.name}`);
  if (record.category) parts.push(`Category: ${record.category}`);
  const desc = record.answers.category_description || record.answers.other_context || '';
  if (desc) parts.push(`Summary: ${desc}`);
  if (record.answers.urgency_deadline) parts.push(`Urgency: ${record.answers.urgency_deadline}`);
  if (record.callback) parts.push(`Callback: ${record.callback}`);
  if (record.best_time) parts.push(`Best time: ${record.best_time}`);
  return parts.join(' • ').trim();
}

function makeGatherTwiml(ttsUrl) {
  const actionUrl = `${PUBLIC_BASE_URL}/twiml`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${escapeHtml(actionUrl)}" method="POST" speechTimeout="auto" timeout="6">
    <Play>${escapeHtml(ttsUrl)}</Play>
    <Pause length="1"/>
  </Gather>
</Response>`;
}

function makePlayTwiml(ttsUrl, { hangup = false } = {}) {
  const actionUrl = `${PUBLIC_BASE_URL}/twiml`;
  if (hangup) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeHtml(ttsUrl)}</Play>
  <Hangup/>
</Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeHtml(ttsUrl)}</Play>
  <Gather input="speech" action="${escapeHtml(actionUrl)}" method="POST" speechTimeout="auto" timeout="6"/>
</Response>`;
}

function makeErrorTwiml() {
  const actionUrl = `${PUBLIC_BASE_URL}/twiml`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${escapeHtml('Sorry, something went wrong. Please try again later.')}</Say>
  <Gather input="speech" action="${escapeHtml(actionUrl)}" method="POST" speechTimeout="auto" timeout="5"/>
</Response>`;
}

async function storeTtsText(text) {
  const cache = await loadTtsCache();
  const id = crypto.randomUUID();
  cache[id] = { text, created_at: Date.now() };
  await saveTtsCache(cache);
  return id;
}

async function makePlayUrl(text) {
  if (text.length > 200) {
    const id = await storeTtsText(text);
    return `${PUBLIC_BASE_URL}/api/tts?id=${encodeURIComponent(id)}`;
  }
  return `${PUBLIC_BASE_URL}/api/tts?text=${encodeURIComponent(text)}`;
}

function getQuestionList(category, { limitFollowups = true } = {}) {
  const cat = CATEGORY_OPTIONS.includes(category) ? category : 'other';
  const followups = QUESTION_SETS[cat] || QUESTION_SETS.other;
  return [
    ...QUESTION_SETS.universal,
    ...(limitFollowups ? followups.slice(0, 2) : followups)
  ];
}

function getNextQuestion(record) {
  const questions = getQuestionList(record.category || 'other');
  for (const q of questions) {
    if (!record.answers[q.id]) return q;
  }
  return null;
}

function recordAnswer(record, questionId, text) {
  if (!questionId) return record;
  record.answers[questionId] = text;

  if (questionId === 'name_callback') {
    const name = extractName(text);
    const phone = extractPhone(text);
    if (name) record.name = name;
    if (phone) record.callback = phone;
  }

  if (questionId === 'best_time_location') {
    record.best_time = text;
    record.answers.location_state = text;
  }

  if (questionId === 'category_description') {
    record.category = detectCategory(text, record.category);
    record.answers.category_description = text;
  }

  return record;
}

function formatSummaryScript(record) {
  const summary = buildSummary(record) || 'Thanks. I have your details.';
  return `${summary} Thank you. The attorney will review and call you back.`;
}

async function maybeSummarizeWithAI(record) {
  if (!OPENAI_API_KEY) return buildSummary(record);
  const payload = {
    model: OPENAI_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'Summarize the intake in one short paragraph for an attorney. No legal advice. No mention of contacting a lawyer.'
      },
      {
        role: 'user',
        content: JSON.stringify({
          name: record.name,
          callback: record.callback,
          best_time: record.best_time,
          category: record.category,
          answers: record.answers
        })
      }
    ],
    response_format: { type: 'text' }
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) return buildSummary(record);
  const data = await res.json();
  return String(data.choices?.[0]?.message?.content || '').trim() || buildSummary(record);
}

/* =========================
   ROUTES
========================= */
app.get('/health', async () => ({ ok: true }));
app.get('/favicon.ico', async (_, reply) => reply.code(204).send());

app.get('/dashboard', async (_, reply) => {
  const db = await loadAll();
  const callers = Object.values(db.callers || {})
    .map((c) => normalizeRecord(c.caller, c))
    .sort((a, b) => b.updated_at - a.updated_at);

  const rows = callers
    .map((c) => {
      const date = new Date(c.updated_at || 0).toLocaleString();
      const summary = (c.summary || '').slice(0, 120);
      return `<tr>
        <td><a href="/dashboard/${encodeURIComponent(c.caller)}">${escapeHtml(c.caller)}</a></td>
        <td>${escapeHtml(c.name || '—')}</td>
        <td>${escapeHtml(c.category || 'other')}</td>
        <td><span class="status ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span></td>
        <td>${escapeHtml(date)}</td>
        <td>${escapeHtml(summary || '—')}</td>
        <td><a class="btn" href="/dashboard/${encodeURIComponent(c.caller)}">Open</a></td>
      </tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Ava Intake Dashboard</title>
  <style>
    :root{
      --ink:#1f2430;--muted:#6b7280;--accent:#0f766e;--bg:#f8f4ee;
      --card:#ffffff;--line:#e6e2d9;--warn:#a16207;--ok:#0f766e;--danger:#b91c1c;
    }
    body{margin:0;font-family:"Palatino Linotype","Book Antiqua",Palatino,serif;background:var(--bg);color:var(--ink);}
    header{padding:28px 40px;background:linear-gradient(135deg,#f0e7d8,#f7f1e7);}
    h1{margin:0;font-size:28px;letter-spacing:0.5px;}
    .sub{color:var(--muted);margin-top:6px;}
    main{padding:24px 40px;}
    table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);}
    th,td{padding:12px 10px;border-bottom:1px solid var(--line);text-align:left;font-size:14px;}
    th{background:#fbf7f1;font-weight:600;}
    .status{padding:4px 8px;border-radius:999px;background:#f1ede5;font-size:12px;text-transform:capitalize;}
    .status.new{background:#e8e0d4;}
    .status.followup{background:#fde68a;color:#7c5000;}
    .status.scheduled{background:#d1fae5;color:#065f46;}
    .status.closed{background:#fee2e2;color:#7f1d1d;}
    .btn{display:inline-block;padding:6px 10px;border-radius:8px;background:var(--accent);color:white;text-decoration:none;font-size:12px;}
    .empty{padding:20px;color:var(--muted);}
  </style>
</head>
<body>
  <header>
    <h1>Attorney Intake Dashboard</h1>
    <div class="sub">Review callers, summaries, and next steps. Keep internal notes private.</div>
  </header>
  <main>
    <table>
      <thead>
        <tr>
          <th>Caller</th>
          <th>Name</th>
          <th>Category</th>
          <th>Status</th>
          <th>Last Updated</th>
          <th>Summary</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="7" class="empty">No calls yet.</td></tr>'}</tbody>
    </table>
  </main>
</body>
</html>`;

  reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
});

app.get('/dashboard/:caller', async (req, reply) => {
  const caller = req.params.caller;
  const record = await getCaller(caller);

  if (!record) {
    reply.code(404).send('Not found');
    return;
  }

  const questionList = getQuestionList(record.category || 'other', { limitFollowups: false });
  const answerRows = questionList
    .map((q) => `<tr><td>${escapeHtml(q.label)}</td><td>${escapeHtml(record.answers[q.id] || '—')}</td></tr>`)
    .join('');

  const historyHtml = (record.history || [])
    .map(
      (h) =>
        `<div class="msg ${escapeHtml(h.role)}"><span>${escapeHtml(h.role)}</span>${escapeHtml(h.text || '')}</div>`
    )
    .join('');

  const summary = escapeHtml(record.summary || '—');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Caller ${escapeHtml(caller)}</title>
  <style>
    :root{
      --ink:#1f2430;--muted:#6b7280;--accent:#0f766e;--bg:#f8f4ee;
      --card:#ffffff;--line:#e6e2d9;
    }
    body{margin:0;font-family:"Palatino Linotype","Book Antiqua",Palatino,serif;background:var(--bg);color:var(--ink);}
    header{padding:24px 40px;background:linear-gradient(135deg,#efe5d4,#fbf7f1);}
    a{color:var(--accent);text-decoration:none;}
    main{padding:24px 40px;display:grid;grid-template-columns:1.4fr 1fr;gap:18px;}
    .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;}
    h1{margin:0 0 8px;}
    h2{margin:0 0 12px;font-size:18px;}
    table{width:100%;border-collapse:collapse;font-size:14px;}
    td{padding:8px;border-bottom:1px solid var(--line);}
    .msg{padding:8px 10px;border-radius:10px;margin:8px 0;background:#faf6ef;font-size:14px;}
    .msg span{display:block;font-size:11px;color:var(--muted);text-transform:capitalize;}
    textarea{width:100%;min-height:120px;border:1px solid var(--line);border-radius:8px;padding:8px;font-family:inherit;}
    select,button,input{font-family:inherit;}
    button{background:var(--accent);color:#fff;border:none;border-radius:8px;padding:8px 12px;cursor:pointer;}
    .meta{color:var(--muted);font-size:13px;margin-bottom:8px;}
    .stack{display:flex;flex-direction:column;gap:10px;}
    @media (max-width: 900px){main{grid-template-columns:1fr;}}
  </style>
</head>
<body>
  <header>
    <a href="/dashboard">← Back to dashboard</a>
    <h1>Caller: ${escapeHtml(caller)}</h1>
    <div class="meta">Last updated: ${escapeHtml(new Date(record.updated_at || 0).toLocaleString())}</div>
  </header>
  <main>
    <div class="stack">
      <div class="card">
        <h2>Summary</h2>
        <p>${summary}</p>
      </div>
      <div class="card">
        <h2>Core Intake Answers</h2>
        <table>${answerRows || '<tr><td colspan="2">No answers yet.</td></tr>'}</table>
      </div>
      <div class="card">
        <h2>Transcript</h2>
        ${historyHtml || '<div class="meta">No transcript yet.</div>'}
      </div>
    </div>
    <div class="stack">
      <div class="card">
        <h2>Internal Notes</h2>
        <form method="POST" action="/dashboard/${encodeURIComponent(caller)}">
          <label class="meta">Status</label>
          <select name="status">
            ${['new', 'followup', 'scheduled', 'closed']
              .map((s) => `<option value="${s}" ${record.status === s ? 'selected' : ''}>${s}</option>`)
              .join('')}
          </select>
          <label class="meta" style="margin-top:10px;display:block;">Notes</label>
          <textarea name="internal_notes">${escapeHtml(record.internal_notes || '')}</textarea>
          <div style="margin-top:10px;">
            <button type="submit">Save</button>
          </div>
        </form>
      </div>
      <div class="card">
        <h2>Export</h2>
        <div class="meta">JSON for case file.</div>
        <a href="/api/export/${encodeURIComponent(caller)}">Download JSON</a>
      </div>
    </div>
  </main>
</body>
</html>`;

  reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
});

app.post('/dashboard/:caller', async (req, reply) => {
  const caller = req.params.caller;
  const status = String(req.body?.status || '').toLowerCase();
  const notes = String(req.body?.internal_notes || '');

  const safeStatus = ['new', 'followup', 'scheduled', 'closed'].includes(status) ? status : 'new';
  await updateCaller(caller, {
    status: safeStatus,
    internal_notes: notes,
    updated_at: Date.now()
  });

  reply.code(303).header('Location', `/dashboard/${encodeURIComponent(caller)}`).send();
});

app.get('/api/export/:caller', async (req, reply) => {
  const record = await getCaller(req.params.caller);
  if (!record) {
    reply.code(404).send({ error: 'Not found' });
    return;
  }
  reply.send(record);
});

app.get('/api/tts', async (req, reply) => {
  const textParam = (req.query?.text || '').toString();
  const idParam = (req.query?.id || '').toString();
  let text = textParam;

  if (!text && idParam) {
    const cache = await loadTtsCache();
    text = cache[idParam]?.text || '';
  }

  if (!text) {
    reply.code(400).send({ error: 'Missing text' });
    return;
  }

  try {
    const ttsRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          Accept: 'audio/mpeg',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.85,
            style: 0.65,
            use_speaker_boost: true
          }
        })
      }
    );

    if (!ttsRes.ok) {
      const errText = await ttsRes.text().catch(() => '');
      throw new Error(`ElevenLabs error: ${ttsRes.status} ${errText}`);
    }

    const audio = Buffer.from(await ttsRes.arrayBuffer());
    reply.header('Content-Type', 'audio/mpeg').send(audio);
  } catch (err) {
    app.log.error({ err: String(err) }, 'TTS error');
    reply.code(500).send({ error: 'TTS failed' });
  }
});

app.post('/twiml', async (req, reply) => {
  const caller = normalizeCaller(req.body?.From);
  const speech = (req.body?.SpeechResult || '').trim();

  try {
    let record = await getOrCreateCaller(caller);

    if (speech) {
      record.history.push({ role: 'caller', text: speech, ts: Date.now() });
      record = recordAnswer(record, record.last_question_id, speech);
    }

    if (record.turn_count >= MAX_TURNS - 1) {
      record.summary = await maybeSummarizeWithAI(record);
      record.stage = 'done';
      record.turn_count += 1;
      record.updated_at = Date.now();
      await upsertCaller(record);
      const closing = formatSummaryScript(record);
      const ttsUrl = await makePlayUrl(closing);
      record.history.push({ role: 'assistant', text: closing, ts: Date.now() });
      await upsertCaller(record);
      reply.header('Content-Type', 'text/xml').send(makePlayTwiml(ttsUrl, { hangup: true }));
      return;
    }

    const nextQuestion = getNextQuestion(record);
    if (!nextQuestion) {
      record.summary = await maybeSummarizeWithAI(record);
      record.stage = 'done';
      record.updated_at = Date.now();
      await upsertCaller(record);
      const closing = formatSummaryScript(record);
      const ttsUrl = await makePlayUrl(closing);
      record.history.push({ role: 'assistant', text: closing, ts: Date.now() });
      await upsertCaller(record);
      reply.header('Content-Type', 'text/xml').send(makePlayTwiml(ttsUrl, { hangup: true }));
      return;
    }

    record.last_question_id = nextQuestion.id;
    record.turn_count += 1;
    record.stage = 'collect';
    record.updated_at = Date.now();
    await upsertCaller(record);

    const ttsUrl = await makePlayUrl(nextQuestion.ask);
    record.history.push({ role: 'assistant', text: nextQuestion.ask, ts: Date.now() });
    record.summary = await maybeSummarizeWithAI(record);
    record.updated_at = Date.now();
    await upsertCaller(record);

    reply.header('Content-Type', 'text/xml').send(makeGatherTwiml(ttsUrl));
  } catch (err) {
    app.log.error({ err: String(err), caller }, 'Twiml error');
    reply.header('Content-Type', 'text/xml').send(makeErrorTwiml());
  }
});

/* =========================
   START HTTP SERVER
========================= */
await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(`BOOT server=${SERVER_PATH}`);
app.log.info(`HTTP listening on http://127.0.0.1:${PORT}`);
