// Adaptive simulated caller. Decides each response from the field Ava is
// actually requesting (authoritative session.lastQuestionId, with a text
// fallback), applies scheduled scenario events, and never hard-codes a fixed
// transcript order. Pure/synthetic — no network, no secrets.

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** "+17045550128" -> "seven zero four, five five five, zero one two eight" */
export function phoneToSpoken(e164) {
  const digits = String(e164 || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (digits.length < 10) return String(e164 || '');
  const say = (chunk) => chunk.split('').map((d) => DIGIT_WORDS[Number(d)] ?? d).join(' ');
  return `${say(digits.slice(0, 3))}, ${say(digits.slice(3, 6))}, ${say(digits.slice(6, 10))}`;
}

/**
 * Classify the field Ava is asking for. Prefer what Ava actually SAID (the
 * spoken question text) — a real caller answers what they hear, not an internal
 * question id. The tracked questionId is only a fallback, because the controller
 * can (and in this build does) leave lastQuestionId desynced from the spoken
 * question; answering the spoken question is the faithful caller behavior.
 */
export function classifyQuestion(questionId, questionText) {
  const t = String(questionText || '').toLowerCase();
  if (t) {
    if (/\bnames?\b|your name|spell (your|that)|who am i speaking|who's calling/.test(t)) return 'name';
    if (/number|phone|reach you|call you (back|at)|best way to reach|callback|digits/.test(t)) return 'callback';
    if (/type of (legal )?(matter|case)|practice area|what kind of (case|matter)|area of law|what.*legal matter/.test(t)) return 'practice';
    if (/new or (an )?existing|worked with us|called (us )?before|returning client|existing client/.test(t)) return 'caller_type';
    if (/anything else|is there anything|one last thing|before i let you go|else the attorney/.test(t)) return 'final';
    if (/what happened|tell me|briefly|what.?s going on|situation|help you with|reason for your call|going on today/.test(t)) return 'summary';
  }
  const id = String(questionId || '').toLowerCase();
  if (id === 'full_name') return 'name';
  if (id === 'callback_number') return 'callback';
  if (id === 'practice_area') return 'practice';
  if (id === 'case_summary') return 'summary';
  if (id === '__caller_type__') return 'caller_type';
  if (id === '__phone_retry__') return 'phone_retry';
  if (id === 'final_clarify') return 'final';
  return 'unknown';
}

const AFFIRM = { text: "Yes, that's right.", confidence: 0.95 };

export function createSimulatedCaller(scenario) {
  const facts = scenario.facts || {};
  const events = Array.isArray(scenario.events) ? scenario.events : [];
  const occurrence = new Map();     // questionId/kind -> times asked
  let firstResponseDone = false;
  let callerTurn = 0;               // Nth caller utterance (for atCallerTurn events)
  const consumedAtTurn = new Set(); // indices of fired atCallerTurn events
  const consumedFirstInject = { done: false };
  const unexpected = [];

  function nextOccurrence(key) {
    const n = (occurrence.get(key) || 0) + 1;
    occurrence.set(key, n);
    return n;
  }

  function findEvent(kind, occ) {
    // Match events by the SPOKEN kind only. Matching by the tracked questionId
    // would re-introduce the controller's lastQuestionId desync (e.g. fire a
    // callback event on a spoken name question), so it is deliberately excluded.
    return events.find((e) => {
      if (e.injectAt) return false; // first-inject events handled separately
      const when = String(e.whenQuestionId || '').toLowerCase();
      const matchKind = when === kind
        || (kind === 'callback' && (when === 'callback_number' || when === '__phone_retry__'))
        || (kind === 'phone_retry' && when === '__phone_retry__')
        || (kind === 'name' && when === 'full_name')
        || (kind === 'practice' && when === 'practice_area')
        || (kind === 'summary' && when === 'case_summary');
      return matchKind && Number(e.occurrence || 1) === occ;
    });
  }

  function defaultFor(kind) {
    switch (kind) {
      case 'name':
        return { text: facts.full_name || 'the caller', confidence: 0.95 };
      case 'callback':
      case 'phone_retry':
        if (!facts.callback_number) return { text: "I'd rather not say.", confidence: 0.95 };
        return { text: phoneToSpoken(facts.callback_number), confidence: 0.96 };
      case 'practice':
        return { text: facts.practice_area || facts.case_summary || 'a legal matter', confidence: 0.95 };
      case 'summary':
        return { text: facts.case_summary || scenario.opening_statement || 'I need legal help.', confidence: 0.95 };
      case 'caller_type':
        return { text: scenario.prior_lead ? "I've called before." : "I'm a new client.", confidence: 0.95 };
      case 'final':
        return { text: "No, that's everything, thank you.", confidence: 0.95 };
      default:
        return null;
    }
  }

  return {
    /**
     * @param {{questionId?:string, questionText?:string}} ask
     * @returns {{text:string, confidence:number, kind:string, source:string}}
     */
    respond(ask) {
      const kind = classifyQuestion(ask.questionId, ask.questionText);
      callerTurn += 1;

      // 1. First-response proactive injection (e.g. caller opens with a question).
      if (!firstResponseDone) {
        firstResponseDone = true;
        const inject = events.find((e) => e.injectAt === 'first');
        if (inject && !consumedFirstInject.done) {
          consumedFirstInject.done = true;
          return { text: inject.callerText, confidence: inject.speechConfidence ?? 0.95, kind, source: 'inject-first' };
        }
        // Otherwise open with the presenting problem.
        return { text: scenario.opening_statement || defaultFor('summary').text, confidence: 0.95, kind, source: 'opening' };
      }

      // 2. Unsolicited scheduled event pinned to a specific caller turn (e.g. an
      //    unsolicited correction) — fires regardless of the field Ava is asking.
      const atIdx = events.findIndex((e, i) => Number.isInteger(e.atCallerTurn) && e.atCallerTurn === callerTurn && !consumedAtTurn.has(i));
      if (atIdx >= 0) {
        consumedAtTurn.add(atIdx);
        const e = events[atIdx];
        return { text: e.callerText, confidence: e.speechConfidence ?? 0.95, kind, source: `atCallerTurn#${callerTurn}` };
      }

      // 3. Scheduled event for this field + occurrence.
      const occ = nextOccurrence(kind === 'unknown' ? String(ask.questionId || 'unknown') : kind);
      const ev = findEvent(kind, occ);
      if (ev) {
        return { text: ev.callerText, confidence: ev.speechConfidence ?? 0.95, kind, source: `event:${ev.whenQuestionId}#${occ}` };
      }

      // 3. Default fact mapping.
      const def = defaultFor(kind);
      if (def) return { ...def, kind, source: 'default' };

      // 4. Unexpected question -> respond conservatively and record it.
      unexpected.push({ questionId: ask.questionId, questionText: ask.questionText });
      return { ...AFFIRM, kind, source: 'conservative-unexpected' };
    },
    unexpectedQuestions: () => unexpected.slice(),
  };
}
