import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'data', 'ava.db');

let _db = null;

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

export function initSchema() {
  const db = getDb();
  db.exec(`
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
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_callSid  ON calls(callSid);
    CREATE        INDEX IF NOT EXISTS idx_calls_updatedAt ON calls(updatedAt DESC);
    CREATE        INDEX IF NOT EXISTS idx_calls_leadId    ON calls(leadId);

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
    );
    CREATE INDEX IF NOT EXISTS idx_leads_updatedAt ON leads(updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_leads_fromPhone ON leads(fromPhone);

    CREATE TABLE IF NOT EXISTS sessions (
      callSid   TEXT PRIMARY KEY,
      data      TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);

  // Migration: add caller_type column if it doesn't exist yet
  const leadCols = db.prepare('PRAGMA table_info(leads)').all().map(c => c.name);
  if (!leadCols.includes('caller_type')) {
    db.exec("ALTER TABLE leads ADD COLUMN caller_type TEXT NOT NULL DEFAULT ''");
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString(); }

function parseCall(row) {
  return { ...row, collected: JSON.parse(row.collected || '{}'), transcript: JSON.parse(row.transcript || '[]') };
}

function parseLead(row) {
  return { ...row, transcript: JSON.parse(row.transcript || '[]'), timeline: JSON.parse(row.timeline || '[]') };
}

function _saveCalls(calls) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO calls (id, callSid, firmId, fromPhone, leadId, status, startedAt, updatedAt, endedAt, outcome, collected, transcript)
    VALUES (@id, @callSid, @firmId, @fromPhone, @leadId, @status, @startedAt, @updatedAt, @endedAt, @outcome, @collected, @transcript)
    ON CONFLICT(id) DO UPDATE SET
      status     = excluded.status,
      updatedAt  = excluded.updatedAt,
      endedAt    = excluded.endedAt,
      outcome    = excluded.outcome,
      collected  = excluded.collected,
      transcript = excluded.transcript
  `);
  db.transaction((list) => {
    for (const c of list) {
      stmt.run({
        ...c,
        endedAt:    c.endedAt ?? null,
        collected:  JSON.stringify(c.collected  || {}),
        transcript: JSON.stringify(c.transcript || []),
      });
    }
  })(calls.slice(0, 500));
}

function _saveLeads(leads) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO leads (id, firmId, fromPhone, full_name, callback_number, practice_area, case_summary, caller_type, status, lastCallSid, createdAt, updatedAt, transcript, timeline)
    VALUES (@id, @firmId, @fromPhone, @full_name, @callback_number, @practice_area, @case_summary, @caller_type, @status, @lastCallSid, @createdAt, @updatedAt, @transcript, @timeline)
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
  `);
  db.transaction((list) => {
    for (const l of list) {
      stmt.run({
        ...l,
        caller_type: l.caller_type || '',
        transcript: JSON.stringify(l.transcript || []),
        timeline:   JSON.stringify(l.timeline   || []),
      });
    }
  })(leads.slice(0, 500));
}

function _saveSessions(sessions) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO sessions (callSid, data, createdAt, updatedAt)
    VALUES (@callSid, @data, @createdAt, @updatedAt)
    ON CONFLICT(callSid) DO UPDATE SET data = excluded.data, updatedAt = excluded.updatedAt
  `);
  db.transaction((entries) => {
    for (const [callSid, session] of entries) {
      stmt.run({
        callSid,
        data:      JSON.stringify(session),
        createdAt: session.createdAt || nowIso(),
        updatedAt: session.updatedAt || nowIso(),
      });
    }
  })(Object.entries(sessions));
}

// ── Public async API (drop-in replacements for JSON helpers) ──────────────────

export async function loadCalls() {
  return getDb().prepare('SELECT * FROM calls ORDER BY updatedAt DESC LIMIT 500').all().map(parseCall);
}

export async function saveCalls(calls) { _saveCalls(calls); }

export async function loadLeads() {
  return getDb().prepare('SELECT * FROM leads ORDER BY updatedAt DESC LIMIT 500').all().map(parseLead);
}

export async function saveLeads(leads) { _saveLeads(leads); }

export async function loadSessions() {
  const rows = getDb().prepare('SELECT callSid, data FROM sessions').all();
  const result = {};
  for (const row of rows) {
    try { result[row.callSid] = JSON.parse(row.data); } catch { /* skip corrupt */ }
  }
  return result;
}

export async function saveSessions(sessions) { _saveSessions(sessions); }

// ── Efficient transactional artifact persist ──────────────────────────────────

export async function persistSessionArtifacts(session, { assistantText, callerText, done }) {
  const db = getDb();
  const now = nowIso();
  const newEntries = [];
  if (callerText)   newEntries.push({ role: 'caller',    text: callerText,   ts: now });
  if (assistantText) newEntries.push({ role: 'assistant', text: assistantText, ts: now });

  db.transaction(() => {
    // ── calls ──────────────────────────────────────────────────────────────
    const existingCall = db.prepare(
      'SELECT id, transcript, endedAt, outcome FROM calls WHERE callSid = ?'
    ).get(session.callSid);

    if (!existingCall) {
      db.prepare(`
        INSERT INTO calls (id, callSid, firmId, fromPhone, leadId, status, startedAt, updatedAt, endedAt, outcome, collected, transcript)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.callId, session.callSid, session.firmId, session.fromPhone, session.leadId,
        done ? 'completed' : 'in_progress',
        now, now,
        done ? now : null,
        done ? 'intake_complete' : '',
        JSON.stringify(session.collected),
        JSON.stringify(newEntries),
      );
    } else {
      const transcript = JSON.parse(existingCall.transcript || '[]');
      transcript.push(...newEntries);
      db.prepare(`
        UPDATE calls
        SET status = ?, updatedAt = ?, endedAt = ?, outcome = ?, collected = ?, transcript = ?
        WHERE callSid = ?
      `).run(
        done ? 'completed' : 'in_progress',
        now,
        done ? now : existingCall.endedAt,
        done ? 'intake_complete' : existingCall.outcome,
        JSON.stringify(session.collected),
        JSON.stringify(transcript),
        session.callSid,
      );
    }

    // ── leads ──────────────────────────────────────────────────────────────
    const existingLead = db.prepare('SELECT * FROM leads WHERE id = ?').get(session.leadId);

    if (!existingLead) {
      db.prepare(`
        INSERT INTO leads (id, firmId, fromPhone, full_name, callback_number, practice_area, case_summary, caller_type, status, lastCallSid, createdAt, updatedAt, transcript, timeline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
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
      );
    } else {
      const transcript = JSON.parse(existingLead.transcript || '[]');
      transcript.push(...newEntries);
      const timeline = JSON.parse(existingLead.timeline || '[]');
      db.prepare(`
        UPDATE leads
        SET full_name = ?, callback_number = ?, practice_area = ?, case_summary = ?, caller_type = ?,
            status = ?, lastCallSid = ?, updatedAt = ?, transcript = ?, timeline = ?
        WHERE id = ?
      `).run(
        session.collected.full_name       || existingLead.full_name,
        session.collected.callback_number || existingLead.callback_number,
        session.collected.practice_area   || existingLead.practice_area,
        session.collected.case_summary    || existingLead.case_summary,
        session.callerType                || existingLead.caller_type || '',
        done ? 'ready_for_review' : 'in_progress',
        session.callSid, now,
        JSON.stringify(transcript),
        JSON.stringify(timeline),
        session.leadId,
      );
    }
  })();
}

// ── One-time JSON → SQLite migration ─────────────────────────────────────────

export async function migrateFromJson({ callsFile, leadsFile, sessionsFile, logger }) {
  const { readFile, rename } = await import('node:fs/promises');

  async function tryMigrate(label, file, migrate) {
    try {
      const raw  = await readFile(file, 'utf8');
      const data = JSON.parse(raw);
      const count = migrate(data);
      await rename(file, `${file}.backup`);
      if (count) logger(`Migrated ${count} ${label} from JSON → SQLite (backup at ${file}.backup)`);
    } catch (err) {
      if (err?.code !== 'ENOENT') logger(`Migration warning [${label}]: ${err.message}`);
    }
  }

  await tryMigrate('calls', callsFile, (calls) => {
    if (!Array.isArray(calls) || !calls.length) return 0;
    _saveCalls(calls);
    return calls.length;
  });

  await tryMigrate('leads', leadsFile, (leads) => {
    if (!Array.isArray(leads) || !leads.length) return 0;
    _saveLeads(leads);
    return leads.length;
  });

  await tryMigrate('sessions', sessionsFile, (sessions) => {
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return 0;
    const entries = Object.keys(sessions).length;
    if (!entries) return 0;
    _saveSessions(sessions);
    return entries;
  });
}
