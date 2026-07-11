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

console.log('verify-conversation-guards: D2 assertions passed');
