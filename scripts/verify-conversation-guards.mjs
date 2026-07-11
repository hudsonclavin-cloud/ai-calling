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

console.log('verify-conversation-guards: D2-D3 assertions passed');
