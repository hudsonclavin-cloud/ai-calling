// Deterministic evaluation of a simulation run. Reads calls.jsonl + run-meta.json
// from a results dir and writes summary.json, report.md, failures.md.
// No LLM is used for field accuracy — comparisons are normalized string/keyword.
//
// Usage (standalone re-eval): node streaming/simulation/evaluate-results.mjs <results-dir>

import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PROHIBITED = ['Right', 'Mm-hm', 'Okay', 'Alright', 'Of course', 'Sure', 'Perfect'];
const CORE_QUESTION_IDS = ['full_name', 'callback_number', 'practice_area', 'case_summary'];

// ── normalizers ────────────────────────────────────────────────────────────────
const normPhone = (x) => {
  const d = String(x || '').replace(/\D/g, '');
  const ten = d.length > 10 ? d.slice(-10) : d;
  return ten.length === 10 ? '+1' + ten : '';
};
const normLoose = (x) => String(x || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const normName = (x) => normLoose(x);

function nameMatch(expected, actual) {
  const e = normName(expected); const a = normName(actual);
  if (!e) return true;
  if (!a) return false;
  return a === e || a.includes(e) || e.includes(a);
}
function practiceMatch(expected, actual) {
  const e = normLoose(expected); const a = normLoose(actual);
  if (!e) return true;
  return a === e || a.includes(e) || e.includes(a);
}
function summaryMatch(mustInclude, actualSummary, transcript) {
  const keys = Array.isArray(mustInclude) ? mustInclude : [];
  if (keys.length === 0) return { ok: true, missing: [] };
  const hay = normLoose(actualSummary) + ' ' + normLoose((transcript || []).map((t) => t.text || t.content || '').join(' '));
  const missing = keys.filter((k) => !hay.includes(normLoose(k)));
  return { ok: missing.length === 0, missing };
}

// ── prohibited-acknowledgment scan (standalone or sentence-initial only) ────────
export function prohibitedAckHits(transcript) {
  const hits = [];
  for (const t of transcript || []) {
    const role = String(t.role || t.speaker || '').toLowerCase();
    if (!/assistant|ava|agent/.test(role)) continue;
    const text = String(t.text || t.content || '').trim();
    if (!text) continue;
    for (const p of PROHIBITED) {
      const exact = new RegExp(`^${p}\\s*[.!]?$`, 'i');
      const prefix = new RegExp(`^${p}\\b[\\s.,!—-]`, 'i'); // sentence-initial, followed by boundary/punct
      if (exact.test(text) || prefix.test(text)) { hits.push({ phrase: p, text: text.slice(0, 80) }); break; }
    }
  }
  return hits;
}

// ── per-call evaluation ─────────────────────────────────────────────────────────
export function evaluateCall(rec) {
  const exp = rec.expected || {};
  const collected = rec.collected || {};
  const transcript = rec.transcript || [];
  const turns = rec.turns || [];
  const checks = {};
  const defects = [];

  const isCrash = ['loop', 'malformed', 'infra-failure'].includes(rec.status);
  checks.no_loop = rec.status !== 'loop' && rec.turnCount <= 12;
  const crashFree = !isCrash;
  if (rec.status === 'loop') defects.push({ type: 'question loop', detail: `hit max turns (${rec.turnCount})` });
  if (rec.status === 'malformed') defects.push({ type: 'malformed flow', detail: rec.failureReason });
  if (rec.status === 'infra-failure') defects.push({ type: 'infrastructure failure', detail: rec.failureReason });

  // Field checks (only for fields the scenario expects).
  const wantFields = exp.fields || {};
  if (wantFields.full_name != null) {
    checks.field_name = nameMatch(wantFields.full_name, collected.full_name);
    if (!checks.field_name) defects.push({ type: 'wrong/missing name', detail: `expected "${wantFields.full_name}", got "${collected.full_name}"` });
  }
  if (wantFields.callback_number != null) {
    checks.field_phone = normPhone(collected.callback_number) === normPhone(wantFields.callback_number);
    if (!checks.field_phone) defects.push({ type: 'wrong phone number', detail: `expected ${normPhone(wantFields.callback_number)}, got ${normPhone(collected.callback_number) || '(none)'}` });
  }
  if (wantFields.practice_area != null) {
    checks.field_practice = practiceMatch(wantFields.practice_area, collected.practice_area);
    if (!checks.field_practice) defects.push({ type: 'wrong practice area', detail: `expected "${wantFields.practice_area}", got "${collected.practice_area}"` });
  }
  const sm = summaryMatch(exp.summary_must_include, collected.case_summary, transcript);
  if ((exp.summary_must_include || []).length) {
    checks.field_summary = sm.ok;
    if (!sm.ok) defects.push({ type: 'summary missing key facts', detail: `missing: ${sm.missing.join(', ')}` });
  }

  // Completion expectation.
  if (exp.completed === true) {
    checks.completed_ok = rec.status === 'completed' && rec.done;
    if (!checks.completed_ok) defects.push({ type: 'did not complete', detail: `status=${rec.status} done=${rec.done}` });
    // premature hangup: done but required fields missing
    const requiredMissing = CORE_QUESTION_IDS.some((f) => wantFields[f] != null && !(
      f === 'callback_number' ? checks.field_phone : f === 'full_name' ? checks.field_name : f === 'practice_area' ? checks.field_practice : checks.field_summary
    ));
    checks.no_premature_hangup = !(rec.done && requiredMissing);
    if (!checks.no_premature_hangup) defects.push({ type: 'premature hangup', detail: 'closed with required fields missing' });
  } else {
    // early-exit / refuse-callback: must end gracefully, not loop, and NOT invent a number
    checks.completed_ok = !isCrash;
    checks.no_premature_hangup = true;
  }

  // Urgency.
  if (exp.urgent === true) {
    checks.urgent_ok = !!rec.isUrgent;
    if (!checks.urgent_ok) defects.push({ type: 'urgent caller mishandled', detail: 'isUrgent flag not set' });
  }

  // Early exit handled promptly (<=1 Ava turn after the exit utterance).
  if (exp.early_exit === true) {
    const exitIdx = turns.findIndex((t) => /never mind|call back later|have to go|another time|changed my mind|forget it/i.test(t.callerText));
    const turnsAfter = exitIdx >= 0 ? turns.length - 1 - exitIdx : 0;
    checks.early_exit_ok = exitIdx >= 0 && turnsAfter <= 1 && rec.done;
    if (!checks.early_exit_ok) defects.push({ type: 'early exit ignored', detail: exitIdx < 0 ? 'exit utterance not detected' : `${turnsAfter} Ava turns after exit, done=${rec.done}` });
  }

  // Correction recovery.
  if (exp.correction && exp.correction.field && exp.correction.to) {
    const f = exp.correction.field;
    const ok = f === 'callback_number'
      ? normPhone(collected.callback_number) === normPhone(exp.correction.to)
      : f === 'full_name' ? nameMatch(exp.correction.to, collected.full_name)
        : f === 'practice_area' ? practiceMatch(exp.correction.to, collected.practice_area)
          : true;
    checks.correction_recovered = ok;
    if (!ok) defects.push({ type: 'unresolved correction', detail: `${f} should be "${exp.correction.to}", got "${collected[f] || ''}"` });
  }

  // Prohibited acknowledgments in sensitive scenarios.
  const sensitive = !!(exp.distress || exp.correction || exp.caller_question);
  const ackHits = sensitive ? prohibitedAckHits(transcript) : [];
  checks.no_prohibited_ack = ackHits.length === 0;
  for (const h of ackHits) defects.push({ type: 'inappropriate acknowledgment', detail: `"${h.phrase}" in: ${h.text}` });

  // Repeated-question detection (a core field asked 3+ times).
  const qCounts = {};
  for (const t of turns) if (CORE_QUESTION_IDS.includes(t.questionId)) qCounts[t.questionId] = (qCounts[t.questionId] || 0) + 1;
  const repeated = Object.entries(qCounts).filter(([, n]) => n >= 3).map(([q, n]) => `${q}×${n}`);
  checks.no_repeated_question = repeated.length === 0;
  if (repeated.length) defects.push({ type: 'repeated question', detail: repeated.join(', ') });

  // Caller-question handling (soft metric; topical keyword near the question).
  let callerQuestionAnswered = null;
  if (exp.caller_question === true) {
    const joined = normLoose(transcript.filter((t) => /assistant|ava|agent/.test(String(t.role || t.speaker || '').toLowerCase())).map((t) => t.text || t.content || '').join(' '));
    const topical = /(cost|fee|charge|consult|free|attorney will|no charge|assistant|ai|virtual|help you|real)/.test(joined);
    callerQuestionAnswered = rec.status === 'completed' && topical;
    if (!callerQuestionAnswered) defects.push({ type: 'caller question possibly ignored', detail: 'no topical acknowledgment found (soft)' });
  }

  // HARD pass = all present objective checks true (soft caller-question excluded).
  const hardKeys = Object.keys(checks);
  const pass = crashFree && hardKeys.every((k) => checks[k] === true);

  return { scenarioId: rec.scenarioId, family: rec.family, pass, crashFree, checks, defects, callerQuestionAnswered, repeated };
}

// ── aggregate + gates ───────────────────────────────────────────────────────────
function pct(n, d) { return d ? n / d : 1; }
function quantile(sorted, q) { if (!sorted.length) return 0; const i = (sorted.length - 1) * q; const lo = Math.floor(i), hi = Math.ceil(i); return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo); }

export async function evaluateRun(resultsDir) {
  const callsRaw = await fsp.readFile(path.join(resultsDir, 'calls.jsonl'), 'utf8');
  const records = callsRaw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const meta = JSON.parse(await fsp.readFile(path.join(resultsDir, 'run-meta.json'), 'utf8').catch(() => '{}'));

  const evals = records.map(evaluateCall);
  const byId = new Map(records.map((r, i) => [r.scenarioId, { rec: r, ev: evals[i] }]));

  const total = records.length;
  const crashFree = evals.filter((e) => e.crashFree).length;
  const completedExpected = records.filter((r) => r.expected?.completed === true);
  const allFieldsOk = completedExpected.filter((r) => { const e = byId.get(r.scenarioId).ev; return ['field_name', 'field_phone', 'field_practice', 'field_summary'].every((k) => e.checks[k] !== false); });
  const nameScope = records.filter((r) => r.expected?.fields?.full_name != null);
  const nameOk = nameScope.filter((r) => byId.get(r.scenarioId).ev.checks.field_name === true);
  const phoneScope = records.filter((r) => r.expected?.fields?.callback_number != null);
  const phoneOk = phoneScope.filter((r) => byId.get(r.scenarioId).ev.checks.field_phone === true);
  const practiceScope = records.filter((r) => r.expected?.fields?.practice_area != null);
  const practiceOk = practiceScope.filter((r) => byId.get(r.scenarioId).ev.checks.field_practice === true);
  const summaryScope = records.filter((r) => (r.expected?.summary_must_include || []).length);
  const summaryOk = summaryScope.filter((r) => byId.get(r.scenarioId).ev.checks.field_summary === true);
  const corrScope = records.filter((r) => r.expected?.correction);
  const corrOk = corrScope.filter((r) => byId.get(r.scenarioId).ev.checks.correction_recovered === true);
  const lowConfScope = records.filter((r) => /low-confidence|partial-callback/.test(r.family));
  const lowConfOk = lowConfScope.filter((r) => { const e = byId.get(r.scenarioId).ev; return e.checks.field_phone !== false && e.checks.field_name !== false; });
  const returningScope = records.filter((r) => r.family.startsWith('returning'));
  const returningOk = returningScope.filter((r) => byId.get(r.scenarioId).ev.checks.field_phone === true);
  const urgentScope = records.filter((r) => r.expected?.urgent === true);
  const urgentOk = urgentScope.filter((r) => byId.get(r.scenarioId).ev.checks.urgent_ok === true);
  const earlyScope = records.filter((r) => r.expected?.early_exit === true);
  const earlyOk = earlyScope.filter((r) => byId.get(r.scenarioId).ev.checks.early_exit_ok === true);
  const cqScope = records.filter((r) => r.expected?.caller_question === true);
  const cqOk = cqScope.filter((r) => byId.get(r.scenarioId).ev.callerQuestionAnswered === true);

  const prohibitedTotal = evals.reduce((a, e) => a + (e.defects.filter((d) => d.type === 'inappropriate acknowledgment').length), 0);
  const prematureTotal = evals.filter((e) => e.checks.no_premature_hangup === false).length;
  const repeatedCalls = evals.filter((e) => e.repeated && e.repeated.length).length;

  const allProcMs = records.flatMap((r) => r.processingLatencyMs || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const turnCounts = records.map((r) => r.turnCount).sort((a, b) => a - b);

  const gates = [
    { name: '40/40 loop/crash-free', pass: crashFree === total, actual: `${crashFree}/${total}` },
    { name: '>=95% required-field accuracy', pass: pct(allFieldsOk.length, completedExpected.length) >= 0.95, actual: `${(pct(allFieldsOk.length, completedExpected.length) * 100).toFixed(1)}%` },
    { name: '>=95% name accuracy', pass: pct(nameOk.length, nameScope.length) >= 0.95, actual: `${(pct(nameOk.length, nameScope.length) * 100).toFixed(1)}%` },
    { name: '100% callback-number accuracy', pass: phoneOk.length === phoneScope.length, actual: `${phoneOk.length}/${phoneScope.length}` },
    { name: '0 inappropriate distress/correction acknowledgments', pass: prohibitedTotal === 0, actual: String(prohibitedTotal) },
    { name: '0 premature hangups', pass: prematureTotal === 0, actual: String(prematureTotal) },
    { name: '<=2 calls with repeated questions', pass: repeatedCalls <= 2, actual: String(repeatedCalls) },
    { name: '>=95% correction recovery', pass: pct(corrOk.length, corrScope.length) >= 0.95, actual: `${(pct(corrOk.length, corrScope.length) * 100).toFixed(1)}%` },
    { name: 'median processing latency <3s', pass: quantile(allProcMs, 0.5) < 3000, actual: `${Math.round(quantile(allProcMs, 0.5))}ms` },
    { name: 'p95 processing latency <6s', pass: quantile(allProcMs, 0.95) < 6000, actual: `${Math.round(quantile(allProcMs, 0.95))}ms` },
  ];

  const failedScenarios = evals.filter((e) => !e.pass).map((e) => e.scenarioId);
  const infra = records.filter((r) => r.status === 'infra-failure').length;
  const gatesPass = gates.every((g) => g.pass);
  let verdict;
  if (infra > 0) verdict = 'INCONCLUSIVE — HARNESS FAILURE';
  else if (gatesPass) verdict = 'READY FOR FIVE REAL PHONE CANARIES';
  else if (crashFree < total * 0.9 || failedScenarios.length > total * 0.25) verdict = 'NOT READY — SYSTEMIC CONTROLLER FAILURE';
  else verdict = 'NOT READY — NARROW DEFECTS FOUND';

  const metrics = {
    totalCalls: total,
    completedCalls: records.filter((r) => r.status === 'completed').length,
    infraFailures: infra,
    conversationFailures: evals.filter((e) => !e.pass && e.crashFree).length,
    loopCrashFreeRate: pct(crashFree, total),
    allRequiredFieldsAccuracy: pct(allFieldsOk.length, completedExpected.length),
    nameAccuracy: pct(nameOk.length, nameScope.length),
    phoneAccuracy: pct(phoneOk.length, phoneScope.length),
    practiceAccuracy: pct(practiceOk.length, practiceScope.length),
    summaryAccuracy: pct(summaryOk.length, summaryScope.length),
    correctionRecovery: pct(corrOk.length, corrScope.length),
    lowConfidenceRecovery: pct(lowConfOk.length, lowConfScope.length),
    returningCallerAccuracy: pct(returningOk.length, returningScope.length),
    earlyExitAccuracy: pct(earlyOk.length, earlyScope.length),
    urgencyHandlingAccuracy: pct(urgentOk.length, urgentScope.length),
    callerQuestionAnswerRate: pct(cqOk.length, cqScope.length),
    repeatedQuestionRate: pct(repeatedCalls, total),
    prohibitedAcknowledgmentCount: prohibitedTotal,
    prematureHangups: prematureTotal,
    turnCount: { mean: turnCounts.reduce((a, b) => a + b, 0) / (turnCounts.length || 1), median: quantile(turnCounts, 0.5), p95: quantile(turnCounts, 0.95) },
    processingLatencyMs: { mean: Math.round(allProcMs.reduce((a, b) => a + b, 0) / (allProcMs.length || 1)), median: Math.round(quantile(allProcMs, 0.5)), p95: Math.round(quantile(allProcMs, 0.95)) },
  };

  const summary = { runId: meta.runId, commit: meta.commit, model: meta.model, verdict, gates, metrics, failedScenarios, blockedExternalRequests: meta.blockedExternalRequests || [], totalLlmCalls: meta.totalLlmCalls };
  await fsp.writeFile(path.join(resultsDir, 'summary.json'), JSON.stringify(summary, null, 2));
  await fsp.writeFile(path.join(resultsDir, 'report.md'), renderReport({ summary, records, byId, meta }));
  await fsp.writeFile(path.join(resultsDir, 'failures.md'), renderFailures({ records, byId }));
  return summary;
}

function renderReport({ summary, records, byId, meta }) {
  const m = summary.metrics;
  const p = (x) => `${(x * 100).toFixed(1)}%`;
  let out = `# Ava 40-call simulation report\n\n`;
  out += `- Run: \`${summary.runId}\`  · commit \`${(summary.commit || '').slice(0, 7)}\` · model \`${summary.model}\`\n`;
  out += `- Data dir (temp, discarded): \`${meta.dataDir}\`\n`;
  out += `- External services: disabled (${(meta.externalDisabled || []).join(', ')}); OpenAI only. Blocked external attempts: ${(summary.blockedExternalRequests || []).length}\n`;
  out += `- Total measured OpenAI calls: ${summary.totalLlmCalls}\n\n`;
  out += `## Executive summary\n\n**${summary.verdict}**\n\n`;
  out += `## 40-call table\n\n| scenario | completed | fields correct | turns | repeats | latency p50 (ms) | result |\n|---|---|---|---|---|---|---|\n`;
  for (const r of records) {
    const e = byId.get(r.scenarioId).ev;
    const fieldsCorrect = ['field_name', 'field_phone', 'field_practice', 'field_summary'].filter((k) => e.checks[k] === true).length;
    const fieldsScoped = ['field_name', 'field_phone', 'field_practice', 'field_summary'].filter((k) => e.checks[k] !== undefined).length;
    const procs = (r.processingLatencyMs || []).slice().sort((a, b) => a - b);
    const p50 = procs.length ? Math.round(procs[Math.floor((procs.length - 1) * 0.5)]) : 0;
    out += `| ${r.scenarioId} | ${r.status === 'completed' ? 'yes' : r.status} | ${fieldsCorrect}/${fieldsScoped} | ${r.turnCount} | ${e.repeated?.length || 0} | ${p50} | ${e.pass ? 'PASS' : 'FAIL'} |\n`;
  }
  out += `\n## Metrics\n\n`;
  out += `- Completed: ${m.completedCalls}/${m.totalCalls} · loop/crash-free: ${p(m.loopCrashFreeRate)} · infra-failures: ${m.infraFailures} · conversation-failures: ${m.conversationFailures}\n`;
  out += `- All-required-fields accuracy: ${p(m.allRequiredFieldsAccuracy)}\n`;
  out += `- Name: ${p(m.nameAccuracy)} · Phone: ${p(m.phoneAccuracy)} · Practice: ${p(m.practiceAccuracy)} · Summary: ${p(m.summaryAccuracy)}\n`;
  out += `- Correction recovery: ${p(m.correctionRecovery)} · Low-confidence recovery: ${p(m.lowConfidenceRecovery)} · Returning-caller: ${p(m.returningCallerAccuracy)}\n`;
  out += `- Early-exit: ${p(m.earlyExitAccuracy)} · Urgency: ${p(m.urgencyHandlingAccuracy)} · Caller-question answer rate: ${p(m.callerQuestionAnswerRate)}\n`;
  out += `- Repeated-question rate: ${p(m.repeatedQuestionRate)} · Prohibited acknowledgments: ${m.prohibitedAcknowledgmentCount} · Premature hangups: ${m.prematureHangups}\n`;
  out += `- Turn count — mean ${m.turnCount.mean.toFixed(1)} / median ${m.turnCount.median} / p95 ${m.turnCount.p95}\n`;
  out += `- Processing latency — mean ${m.processingLatencyMs.mean}ms / median ${m.processingLatencyMs.median}ms / p95 ${m.processingLatencyMs.p95}ms\n\n`;
  out += `## Launch-gate comparison\n\n| gate | target | actual | result |\n|---|---|---|---|\n`;
  for (const g of summary.gates) out += `| ${g.name} | — | ${g.actual} | ${g.pass ? 'PASS' : 'FAIL'} |\n`;
  out += `\n## Failed scenarios\n\n${summary.failedScenarios.length ? summary.failedScenarios.map((s) => `- ${s}`).join('\n') : '_none_'}\n`;
  out += `\n_See failures.md for turn-level detail. No production code was edited; defects are preserved as observed._\n`;
  return out;
}

function renderFailures({ records, byId }) {
  let out = `# Failure analysis\n\n`;
  const failed = records.filter((r) => !byId.get(r.scenarioId).ev.pass);
  if (!failed.length) { return out + '_No failed calls._\n'; }
  for (const r of failed) {
    const e = byId.get(r.scenarioId).ev;
    out += `## ${r.scenarioId} (${r.family})\n\n`;
    out += `- Status: **${r.status}** · done=${r.done} · turns=${r.turnCount} · urgent=${r.isUrgent}\n`;
    out += `- Description: ${r.description}\n`;
    out += `- Defects: ${e.defects.map((d) => `**${d.type}** (${d.detail})`).join('; ') || '—'}\n`;
    out += `- Expected fields: ${JSON.stringify(r.expected?.fields || {})}\n`;
    out += `- Collected: ${JSON.stringify(r.collected)}\n\n`;
    out += `**Transcript:**\n\n`;
    for (const t of r.transcript || []) {
      const role = /assistant|ava|agent/.test(String(t.role || t.speaker || '').toLowerCase()) ? 'Ava' : 'Caller';
      out += `> **${role}:** ${(t.text || t.content || '').replace(/\n/g, ' ')}\n\n`;
    }
    out += `**Likely defect location:** ${likelyLocation(e)}\n\n---\n\n`;
  }
  return out;
}

function likelyLocation(ev) {
  const types = new Set(ev.defects.map((d) => d.type));
  if (types.has('wrong phone number')) return 'phone extraction / low-confidence retry / carriedCallback promotion (mergeExtracted, __phone_retry__ path)';
  if (types.has('unresolved correction')) return 'correction handling / field-overwrite guard in mergeExtracted';
  if (types.has('inappropriate acknowledgment')) return 'filler / acknowledgment selection (selectThinkingFiller) or system-prompt ack rules';
  if (types.has('question loop') || types.has('repeated question')) return 'question generator / done-gate divergence (buildDeterministicQuestion, interceptor)';
  if (types.has('premature hangup') || types.has('did not complete')) return 'done-gate / completion logic in runNextStepController';
  if (types.has('urgent caller mishandled')) return 'urgency detection (detectUrgency) and prompt urgency handling';
  if (types.has('early exit ignored')) return 'early-exit detection (detectEarlyExit)';
  if (types.has('summary missing key facts')) return 'case_summary extraction';
  return 'controller (runNextStepController)';
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node evaluate-results.mjs <results-dir>'); process.exit(1); }
  evaluateRun(path.resolve(dir)).then((s) => { console.log(JSON.stringify(s.metrics, null, 2)); console.log('verdict:', s.verdict); }).catch((e) => { console.error(e); process.exit(1); });
}
