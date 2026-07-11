import assert from 'node:assert/strict';

function normalizeInternalClarifyingNote(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function buildModelContext(session) {
  return {
    prior_internal_note: normalizeInternalClarifyingNote(session.internalClarifyingNote) || null,
  };
}

function consumeClarifyingNote(session, llm) {
  session.internalClarifyingNote = normalizeInternalClarifyingNote(llm?.clarifying_note);
}

function composeQuestionBody({ llmQuestionText, deterministicQuestion }) {
  return String(llmQuestionText || '').trim() || deterministicQuestion;
}

function parseSpeechConfidence(raw) {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function isLowSpeechConfidence(confidence, threshold) {
  return confidence != null && confidence < threshold;
}

function shouldBlockExactCapture({ expectedField, speechConfidence, threshold }) {
  return isLowSpeechConfidence(speechConfidence, threshold)
    && ['full_name', 'callback_number'].includes(expectedField);
}

function exactFieldClarification(field) {
  if (field === 'full_name') return 'Sorry — I may have heard the name wrong. Could you say your name once more?';
  if (field === 'callback_number') return 'Sorry — I may have missed a digit. Could you repeat the callback number?';
  return '';
}

const FILLER_WORDS = new Set(['ok', 'okay', 'yes', 'no', 'sure', 'go ahead', 'ready', 'hi', 'hello', 'yeah', 'yep', 'yup', 'alright', 'sounds good', 'got it', 'uh huh']);
const AFFIRMATIVE_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'right', 'ok', 'okay', 'sounds good', 'that works', "that's right", "that's correct", 'still good', 'same number', 'same', 'uh huh', 'mm hm', 'mhm']);

function isLikelyPhone(value) {
  return String(value || '').replace(/\D/g, '').length >= 10;
}

function isLikelyName(value, sourceText = '', expectedField = '') {
  const v = String(value || '').trim();
  if (!v) return false;
  const sourceHasNamePrefix = /(?:my name is|this is|i(?:'|’)?m|i am)\s+[A-Za-z]/i.test(sourceText);
  if (expectedField !== 'full_name' && !sourceHasNamePrefix) return false;
  if (/\d/.test(v)) return false;
  if (!/^[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}$/.test(v)) return false;
  const words = v.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 4) return false;
  const lower = v.toLowerCase();
  if (FILLER_WORDS.has(lower) || AFFIRMATIVE_WORDS.has(lower)) return false;
  if (/\b(personal|injury|case|accident|rear-ended|matter|help|legal|divorce|custody|arrested|evicted|fired|harassment|consultation)\b/i.test(v)) return false;
  return true;
}

function isLikelySummary(value, expectedField = '') {
  const v = String(value || '').trim();
  if (!v) return false;
  const lower = v.toLowerCase();
  if (FILLER_WORDS.has(lower) || AFFIRMATIVE_WORDS.has(lower)) return false;
  if (isLikelyPhone(v)) return false;
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

const FILLER_PHRASES = ['Got it — one sec.', 'Okay — let me note that.'];
const QUESTION_FILLER = 'Good question — let me check.';
const CORRECTION_FILLER = 'Ah, got it — one sec.';

function detectUrgency(text) {
  const lower = String(text || '').toLowerCase();
  return /\b(arrested|in jail|emergency|evicted today|court tomorrow|restraining order|accident just happened|just had an accident|just was in an accident|in (a bad|a terrible|a serious) accident|injured right now|going to jail|being evicted|just got hurt|seriously hurt|car accident|hit by a car|i'?m scared|really scared|at the hospital right now|in the hospital right now)\b/.test(lower);
}

function isCallerQuestion(userText) {
  const text = String(userText || '').trim();
  return /\?$/.test(text) || /^(who|what|when|where|why|how|is|are|am|do|does|did|can|could|will|would|should)\b/i.test(text);
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

function selectThinkingFiller(userText, lastFillerIdx = -1) {
  const category = classifyFillerContext(userText);
  if (category === 'urgent_or_distressed') return { category, text: null, fillerIdx: null };
  if (category === 'caller_question') return { category, text: QUESTION_FILLER, fillerIdx: null };
  if (category === 'correction') return { category, text: CORRECTION_FILLER, fillerIdx: null };
  const fillerIdx = FILLER_PHRASES.length > 1 ? (lastFillerIdx + 1) % FILLER_PHRASES.length : 0;
  return { category, text: FILLER_PHRASES[fillerIdx], fillerIdx };
}

const session = { internalClarifyingNote: 'Caller is upset about a PI-only mismatch.' };
const context = buildModelContext(session);
assert.equal(context.prior_internal_note, 'Caller is upset about a PI-only mismatch.');

const spoken = composeQuestionBody({
  llmQuestionText: '',
  deterministicQuestion: 'What is your name?',
});
assert.equal(spoken, 'What is your name?');
assert.equal(spoken.includes('Caller is upset'), false);

const fallbackSpeech = composeQuestionBody({
  llmQuestionText: '',
  deterministicQuestion: 'And briefly, what happened?',
});
assert.equal(fallbackSpeech, 'And briefly, what happened?');

consumeClarifyingNote(session, { clarifying_note: '  New internal note   for next turn.  ' });
assert.equal(session.internalClarifyingNote, 'New internal note for next turn.');

consumeClarifyingNote(session, { clarifying_note: '' });
assert.equal(session.internalClarifyingNote, '');

assert.equal(parseSpeechConfidence('0.82'), 0.82);
assert.equal(parseSpeechConfidence(undefined), null);
assert.equal(parseSpeechConfidence('not-a-number'), null);
assert.equal(isLowSpeechConfidence(0.54, 0.55), true);
assert.equal(isLowSpeechConfidence(null, 0.55), false);
assert.equal(shouldBlockExactCapture({ expectedField: 'full_name', speechConfidence: 0.4, threshold: 0.55 }), true);
assert.equal(shouldBlockExactCapture({ expectedField: 'callback_number', speechConfidence: 0.4, threshold: 0.55 }), true);
assert.equal(exactFieldClarification('full_name'), 'Sorry — I may have heard the name wrong. Could you say your name once more?');
assert.equal(exactFieldClarification('callback_number'), 'Sorry — I may have missed a digit. Could you repeat the callback number?');
assert.equal(shouldBlockExactCapture({ expectedField: 'full_name', speechConfidence: 0.82, threshold: 0.55 }), false);

for (const name of ['Hudson Clavin', 'Hudson', "I'm Hudson Clavin", 'Jean-Luc Picard', "O'Connor"]) {
  const source = name.startsWith("I'm ") ? name : name;
  const value = name.replace(/^I'm\s+/i, '');
  assert.equal(isLikelyName(value, source, 'full_name'), true, `expected name accepted: ${name}`);
}

for (const notName of ['car accident', 'I need legal help', 'okay', '7045551212']) {
  assert.equal(isLikelyName(notName, notName, 'full_name'), false, `expected name rejected: ${notName}`);
}

for (const summary of ['Rear-ended on Tuesday', 'Evicted this morning', 'My son was arrested last night', 'Fired after reporting harassment']) {
  assert.equal(isLikelySummary(summary, 'case_summary'), true, `expected summary accepted: ${summary}`);
}

for (const notSummary of ['okay', 'yes', '7045551212', 'Hudson Clavin']) {
  assert.equal(isLikelySummary(notSummary, 'case_summary'), false, `expected summary rejected: ${notSummary}`);
}

assert.equal(isLikelyName('Hudson Clavin', 'Hudson Clavin', 'full_name'), true);
assert.equal(isLikelyName('Hudson Clavin', 'Hudson Clavin', 'case_summary'), false);

assert.equal(selectThinkingFiller("My husband hit me and I'm scared").text, null);
assert.equal(selectThinkingFiller('I was just in a serious accident').text, null);
assert.equal(selectThinkingFiller('My son was arrested last night').text, null);
assert.equal(selectThinkingFiller('Do you charge for consultations?').text, QUESTION_FILLER);
assert.equal(selectThinkingFiller("No, that's the wrong number").text, CORRECTION_FILLER);
assert.equal(selectThinkingFiller('Actually, my last name is Clavin').text, CORRECTION_FILLER);
assert.equal(FILLER_PHRASES.includes(selectThinkingFiller('I was rear-ended Tuesday').text), true);
assert.equal(selectThinkingFiller('I was rear-ended Tuesday').text === 'Right.', false);
assert.equal(selectThinkingFiller('I was rear-ended Tuesday').text === 'Mm-hm.', false);
assert.ok(FILLER_PHRASES.includes(selectThinkingFiller('Neutral update', 0).text));

console.log('verify-conversation-guards: D2-D5 assertions passed');
