import { createClient } from '@libsql/client';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'data', 'ava.db');

let _client = null;

function getClient() {
  if (!_client) {
    _client = createClient({ url: `file:${DB_PATH}` });
  }
  return _client;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString(); }

function parseCall(row) {
  return {
    id:         String(row.id),
    callSid:    String(row.callSid),
    firmId:     String(row.firmId),
    fromPhone:  String(row.fromPhone),
    leadId:     String(row.leadId),
    status:     String(row.status),
    startedAt:  String(row.startedAt),
    updatedAt:  String(row.updatedAt),
    endedAt:    row.endedAt != null ? String(row.endedAt) : null,
    outcome:    String(row.outcome),
    collected:  JSON.parse(String(row.collected  || '{}')),
    transcript: JSON.parse(String(row.transcript || '[]')),
  };
}

function parseLead(row) {
  return {
    id:              String(row.id),
    firmId:          String(row.firmId),
    fromPhone:       String(row.fromPhone),
    full_name:       String(row.full_name),
    callback_number: String(row.callback_number),
    practice_area:   String(row.practice_area),
    case_summary:    String(row.case_summary),
    caller_type:     String(row.caller_type || ''),
    status:          String(row.status),
    lastCallSid:     String(row.lastCallSid),
    createdAt:       String(row.createdAt),
    updatedAt:       String(row.updatedAt),
    contacted_at:    row.contacted_at ? String(row.contacted_at) : null,
    transcript:      JSON.parse(String(row.transcript || '[]')),
    timeline:        JSON.parse(String(row.timeline   || '[]')),
  };
}

async function _saveCalls(calls) {
  if (!calls.length) return;
  const client = getClient();
  const stmts = calls.slice(0, 500).map(c => ({
    sql: `
      INSERT INTO calls (id, callSid, firmId, fromPhone, leadId, status, startedAt, updatedAt, endedAt, outcome, collected, transcript)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status     = excluded.status,
        updatedAt  = excluded.updatedAt,
        endedAt    = excluded.endedAt,
        outcome    = excluded.outcome,
        collected  = excluded.collected,
        transcript = excluded.transcript
    `,
    args: [
      c.id, c.callSid, c.firmId, c.fromPhone, c.leadId,
      c.status, c.startedAt, c.updatedAt,
      c.endedAt ?? null,
      c.outcome,
      JSON.stringify(c.collected  || {}),
      JSON.stringify(c.transcript || []),
    ],
  }));
  await client.batch(stmts, 'write');
}

async function _saveLeads(leads) {
  if (!leads.length) return;
  const client = getClient();
  const stmts = leads.slice(0, 500).map(l => ({
    sql: `
      INSERT INTO leads (id, firmId, fromPhone, full_name, callback_number, practice_area, case_summary, caller_type, status, lastCallSid, createdAt, updatedAt, transcript, timeline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        full_name       = excluded.full_name,
        callback_number = excluded.callback_number,
        practice_area   = excluded.practice_area,
        case_summary    = excluded.case_summary,
        caller_type     = excluded.caller_type,
        status          = excluded.status,
        lastCallSid     = excluded.lastCallSid,
        updatedAt       = excluded.updatedAt,
        transcript      = excluded.transcript,
        timeline        = excluded.timeline
    `,
    args: [
      l.id, l.firmId, l.fromPhone,
      l.full_name       || '',
      l.callback_number || '',
      l.practice_area   || '',
      l.case_summary    || '',
      l.caller_type     || '',
      l.status,
      l.lastCallSid,
      l.createdAt, l.updatedAt,
      JSON.stringify(l.transcript || []),
      JSON.stringify(l.timeline   || []),
    ],
  }));
  await client.batch(stmts, 'write');
}

async function _saveSessions(sessions) {
  const entries = Object.entries(sessions);
  if (!entries.length) return;
  const client = getClient();
  const stmts = entries.map(([callSid, session]) => ({
    sql: `
      INSERT INTO sessions (callSid, data, createdAt, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(callSid) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt
    `,
    args: [
      callSid,
      JSON.stringify(session),
      session.createdAt || nowIso(),
      session.updatedAt || nowIso(),
    ],
  }));
  await client.batch(stmts, 'write');
}

// ── Schema ────────────────────────────────────────────────────────────────────

export async function initSchema() {
  const client = getClient();

  await client.execute(`PRAGMA journal_mode = WAL`);
  await client.execute(`PRAGMA synchronous = NORMAL`);
  await client.execute(`PRAGMA foreign_keys = ON`);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS calls (
      id        TEXT PRIMARY KEY,
      callSid   TEXT NOT NULL,
      firmId    TEXT NOT NULL,
      fromPhone TEXT NOT NULL,
      leadId    TEXT NOT NULL,
      status    TEXT NOT NULL DEFAULT 'in_progress',
      startedAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      endedAt   TEXT,
      outcome   TEXT NOT NULL DEFAULT '',
      collected TEXT NOT NULL DEFAULT '{}',
      transcript TEXT NOT NULL DEFAULT '[]'
    )
  `);
  await client.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_callSid  ON calls(callSid)`);
  await client.execute(`CREATE        INDEX IF NOT EXISTS idx_calls_updatedAt ON calls(updatedAt DESC)`);
  await client.execute(`CREATE        INDEX IF NOT EXISTS idx_calls_leadId    ON calls(leadId)`);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS leads (
      id              TEXT PRIMARY KEY,
      firmId          TEXT NOT NULL,
      fromPhone       TEXT NOT NULL,
      full_name       TEXT NOT NULL DEFAULT '',
      callback_number TEXT NOT NULL DEFAULT '',
      practice_area   TEXT NOT NULL DEFAULT '',
      case_summary    TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'in_progress',
      lastCallSid     TEXT NOT NULL DEFAULT '',
      createdAt       TEXT NOT NULL,
      updatedAt       TEXT NOT NULL,
      transcript      TEXT NOT NULL DEFAULT '[]',
      timeline        TEXT NOT NULL DEFAULT '[]'
    )
  `);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_leads_updatedAt ON leads(updatedAt DESC)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_leads_fromPhone ON leads(fromPhone)`);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      callSid   TEXT PRIMARY KEY,
      data      TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);

  // Migrations: add columns that may not exist in older schemas
  const colInfo = await client.execute(`PRAGMA table_info(leads)`);
  const cols = colInfo.rows.map(r => String(r.name));
  if (!cols.includes('caller_type')) {
    await client.execute(`ALTER TABLE leads ADD COLUMN caller_type TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.includes('contacted_at')) {
    await client.execute(`ALTER TABLE leads ADD COLUMN contacted_at TEXT`);
  }
}

// ── Public async API ──────────────────────────────────────────────────────────

export async function loadCalls() {
  const result = await getClient().execute(
    'SELECT * FROM calls ORDER BY updatedAt DESC LIMIT 500'
  );
  return result.rows.map(parseCall);
}

export async function saveCalls(calls) { await _saveCalls(calls); }

export async function loadLeads() {
  const result = await getClient().execute(
    'SELECT * FROM leads ORDER BY updatedAt DESC LIMIT 500'
  );
  return result.rows.map(parseLead);
}

export async function saveLeads(leads) { await _saveLeads(leads); }

// Patch arbitrary whitelisted fields on a lead row
export async function patchLead(id, updates) {
  const allowed = ['status', 'contacted_at'];
  const entries = Object.entries(updates).filter(([k]) => allowed.includes(k));
  if (!entries.length) return;
  const now = nowIso();
  const setClauses = [...entries.map(([k]) => `${k} = ?`), 'updatedAt = ?'].join(', ');
  const args = [...entries.map(([, v]) => v), now, id];
  await getClient().execute({ sql: `UPDATE leads SET ${setClauses} WHERE id = ?`, args });
}

export async function loadSessions() {
  const result = await getClient().execute('SELECT callSid, data FROM sessions');
  const sessions = {};
  for (const row of result.rows) {
    try { sessions[String(row.callSid)] = JSON.parse(String(row.data)); } catch { /* skip corrupt */ }
  }
  return sessions;
}

export async function saveSessions(sessions) { await _saveSessions(sessions); }

// ── Efficient transactional artifact persist ──────────────────────────────────

export async function persistSessionArtifacts(session, { assistantText, callerText, done }) {
  const client = getClient();
  const now = nowIso();
  const newEntries = [];
  if (callerText)    newEntries.push({ role: 'caller',    text: callerText,    ts: now });
  if (assistantText) newEntries.push({ role: 'assistant', text: assistantText, ts: now });

  const tx = await client.transaction('write');
  try {
    // ── calls ──────────────────────────────────────────────────────────────
    const callResult = await tx.execute({
      sql:  'SELECT id, transcript, endedAt, outcome FROM calls WHERE callSid = ?',
      args: [session.callSid],
    });
    const existingCall = callResult.rows[0];

    if (!existingCall) {
      await tx.execute({
        sql: `
          INSERT INTO calls (id, callSid, firmId, fromPhone, leadId, status, startedAt, updatedAt, endedAt, outcome, collected, transcript)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          session.callId, session.callSid, session.firmId, session.fromPhone, session.leadId,
          done ? 'completed' : 'in_progress',
          now, now,
          done ? now : null,
          done ? 'intake_complete' : '',
          JSON.stringify(session.collected),
          JSON.stringify(newEntries),
        ],
      });
    } else {
      const transcript = JSON.parse(String(existingCall.transcript || '[]'));
      transcript.push(...newEntries);
      await tx.execute({
        sql: `
          UPDATE calls
          SET status = ?, updatedAt = ?, endedAt = ?, outcome = ?, collected = ?, transcript = ?
          WHERE callSid = ?
        `,
        args: [
          done ? 'completed' : 'in_progress',
          now,
          done ? now : (existingCall.endedAt ?? null),
          done ? 'intake_complete' : String(existingCall.outcome),
          JSON.stringify(session.collected),
          JSON.stringify(transcript),
          session.callSid,
        ],
      });
    }

    // ── leads ──────────────────────────────────────────────────────────────
    const leadResult = await tx.execute({
      sql:  'SELECT * FROM leads WHERE id = ?',
      args: [session.leadId],
    });
    const existingLead = leadResult.rows[0];

    if (!existingLead) {
      await tx.execute({
        sql: `
          INSERT INTO leads (id, firmId, fromPhone, full_name, callback_number, practice_area, case_summary, caller_type, status, lastCallSid, createdAt, updatedAt, transcript, timeline)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          session.leadId, session.firmId, session.fromPhone,
          session.collected.full_name       || '',
          session.collected.callback_number || session.fromPhone,
          session.collected.practice_area   || '',
          session.collected.case_summary    || '',
          session.callerType                || '',
          done ? 'ready_for_review' : 'in_progress',
          session.callSid,
          now, now,
          JSON.stringify(newEntries),
          JSON.stringify([{ ts: now, type: 'call_started', detail: `Call ${session.callSid} started` }]),
        ],
      });
    } else {
      const transcript = JSON.parse(String(existingLead.transcript || '[]'));
      transcript.push(...newEntries);
      const timeline = JSON.parse(String(existingLead.timeline || '[]'));
      await tx.execute({
        sql: `
          UPDATE leads
          SET full_name = ?, callback_number = ?, practice_area = ?, case_summary = ?, caller_type = ?,
              status = ?, lastCallSid = ?, updatedAt = ?, transcript = ?, timeline = ?
          WHERE id = ?
        `,
        args: [
          session.collected.full_name       || String(existingLead.full_name),
          session.collected.callback_number || String(existingLead.callback_number),
          session.collected.practice_area   || String(existingLead.practice_area),
          session.collected.case_summary    || String(existingLead.case_summary),
          session.callerType                || String(existingLead.caller_type || ''),
          done ? 'ready_for_review' : 'in_progress',
          session.callSid, now,
          JSON.stringify(transcript),
          JSON.stringify(timeline),
          session.leadId,
        ],
      });
    }

    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

// ── One-time JSON → SQLite migration ─────────────────────────────────────────

export async function migrateFromJson({ callsFile, leadsFile, sessionsFile, logger }) {
  const { readFile, rename } = await import('node:fs/promises');

  async function tryMigrate(label, file, migrate) {
    try {
      const raw  = await readFile(file, 'utf8');
      const data = JSON.parse(raw);
      const count = await migrate(data);
      await rename(file, `${file}.backup`);
      if (count) logger(`Migrated ${count} ${label} from JSON → SQLite (backup at ${file}.backup)`);
    } catch (err) {
      if (err?.code !== 'ENOENT') logger(`Migration warning [${label}]: ${err.message}`);
    }
  }

  await tryMigrate('calls', callsFile, async (calls) => {
    if (!Array.isArray(calls) || !calls.length) return 0;
    await _saveCalls(calls);
    return calls.length;
  });

  await tryMigrate('leads', leadsFile, async (leads) => {
    if (!Array.isArray(leads) || !leads.length) return 0;
    await _saveLeads(leads);
    return leads.length;
  });

  await tryMigrate('sessions', sessionsFile, async (sessions) => {
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return 0;
    const entries = Object.keys(sessions).length;
    if (!entries) return 0;
    await _saveSessions(sessions);
    return entries;
  });
}
