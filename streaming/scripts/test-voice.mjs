import 'dotenv/config';

// ── Inlined constants from server.mjs ────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const TONE_PRESETS = {
  warm:         "Your tone is warm, empathetic, and unhurried. Use contractions naturally. Show genuine care. Never robotic.",
  professional: "Your tone is polished and precise. Minimal small talk. Use 'Certainly' not 'Sure'. Address callers by last name if given. Efficient and respectful.",
  friendly:     "Your tone is upbeat and conversational. Short, punchy sentences. Sound like a helpful person — not a corporate recording.",
};

const INDUSTRY_MODULES = {
  law_pi: `INDUSTRY CONTEXT — PERSONAL INJURY LAW:
Callers are typically injured individuals or their families seeking legal help after accidents, slip-and-falls, medical malpractice, defective products, or workplace injuries. Most work on a contingency fee basis (no fee unless the firm wins). Key intake info: accident date, injury type, who was at fault, medical treatment status, insurance involvement. Urgency signals: still receiving treatment, recent accident, upcoming statute of limitations. Common terminology: liability, negligence, damages, settlement, insurance adjuster.`,
};

const REQUIRED_FIELDS_DEFAULT = ['full_name', 'callback_number', 'practice_area', 'case_summary'];

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
  acknowledgments: ['Of course.', 'Sure thing.', 'Absolutely.', 'Thanks.', 'Got it.'],
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

// ── JSON Schema (matches server.mjs exactly) ──────────────────────────────────

const RESPONSE_SCHEMA = {
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

// ── System prompt builder ─────────────────────────────────────────────────────

function buildSystemPrompt(firmConfig) {
  const requiredFields = firmConfig.required_fields || REQUIRED_FIELDS_DEFAULT;
  const toneInstruction = TONE_PRESETS[firmConfig.tone] || TONE_PRESETS['warm'];
  const industryContext = INDUSTRY_MODULES[firmConfig.industry] || INDUSTRY_MODULES['law_pi'];
  const ava_name = firmConfig.ava_name || 'Ava';
  const firm_name = firmConfig.name;
  const requiredFieldsList = requiredFields.join(' | ');

  // Simulate "office is open" context (same as server would for a daytime call)
  const hoursContext = `The office is currently open (Mon-Fri 8:00 AM - 6:00 PM). You may tell the caller someone will be in touch shortly.`;

  return `You are ${ava_name}, a real receptionist at ${firm_name}. You are a person — not a bot, not a checklist, not an AI. Speak like one.

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
}

// ── OpenAI API call (non-streaming for simplicity) ───────────────────────────

async function callAva({ session, userText, firmConfig }) {
  const requiredFields = firmConfig.required_fields || REQUIRED_FIELDS_DEFAULT;
  const wordCount = userText.split(/\s+/).filter(Boolean).length;

  const collectedForPrompt = { ...session.collected };
  if (collectedForPrompt.case_summary?.length > 200) {
    collectedForPrompt.case_summary = collectedForPrompt.case_summary.slice(0, 200);
  }

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

  const systemPrompt = buildSystemPrompt(firmConfig);

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      stream: false,
      temperature: 0.8,
      max_output_tokens: 300,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: systemPrompt }],
        },
        { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(prompt) }] },
      ],
      text: {
        format: { type: 'json_schema', name: 'next_step_output', schema: RESPONSE_SCHEMA, strict: true },
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const outputText = data.output?.[0]?.content?.[0]?.text;
  if (!outputText) throw new Error('No output text in response');
  return JSON.parse(outputText);
}

// ── Grading rubric ────────────────────────────────────────────────────────────

const BANNED_PHRASES = [
  /\bOf course\.\b/i,
  /\bSure thing\.\b/i,
  /\bAbsolutely\.\b/i,
  /\bCertainly!\b/i,
  /\bI understand your concern\b/i,
  /\bThanks for sharing\b/i,
  /\bI appreciate you reaching out\b/i,
];

const ROBOTIC_QUESTION_PATTERNS = [
  /What is your (name|phone|number|address)/i,
  /Please provide/i,
  /Can you give me/i,
  /May I (have|get|ask)/i,
];

const EMPATHY_WORDS = [
  /\bsorry\b/i, /\bawful\b/i, /\bhard\b/i, /\bscary\b/i, /\brough\b/i,
  /\bmust be\b/i, /\bthat's a lot\b/i, /\boh gosh\b/i, /\boh no\b/i,
  /\bgoodness\b/i, /\bfrightening\b/i, /\bterrible\b/i,
];

function countSentences(text) {
  const matches = text.match(/[.!?]+(?:\s|$)/g);
  return matches ? matches.length : 1;
}

function scoreResponse(avaText, callerText, scenarioType) {
  const scores = {};
  const notes = [];

  // 1. Ack specificity (0–3)
  // Check if response opens with a reaction before the first question mark
  const firstQMark = avaText.indexOf('?');
  const preQuestion = firstQMark > 0 ? avaText.slice(0, firstQMark) : avaText;
  const hasAck = preQuestion.trim().length > 10 && !/^(And |Who |What |How |When |Where |Can |Could |Would )/.test(avaText.trim());

  // Check if it mirrors caller's key words
  const callerWords = callerText.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  const avaNorm = avaText.toLowerCase();
  const mirroredWords = callerWords.filter(w => avaNorm.includes(w));
  const mirrorScore = Math.min(mirroredWords.length, 2);

  scores.ack_specificity = hasAck ? Math.min(2 + mirrorScore, 3) : mirrorScore;
  if (!hasAck) notes.push('No clear acknowledgment before question');

  // 2. No banned phrases (0–2, -1 per hit)
  let bannedHits = 0;
  for (const re of BANNED_PHRASES) {
    if (re.test(avaText)) {
      bannedHits++;
      notes.push(`Banned phrase detected: "${avaText.match(re)?.[0]}"`);
    }
  }
  scores.no_banned_phrases = Math.max(2 - bannedHits, 0);

  // 3. Question phrasing (0–2)
  const hasRoboticQuestion = ROBOTIC_QUESTION_PATTERNS.some(re => re.test(avaText));
  scores.question_phrasing = hasRoboticQuestion ? 0 : 2;
  if (hasRoboticQuestion) notes.push('Robotic question phrasing detected');

  // 4. Tone match (0–2)
  const isEmotionalScenario = ['distressed', 'nervous'].includes(scenarioType);
  if (isEmotionalScenario) {
    const hasEmpathy = EMPATHY_WORDS.some(re => re.test(avaText));
    scores.tone_match = hasEmpathy ? 2 : 0;
    if (!hasEmpathy) notes.push('No empathy detected for emotional caller');
  } else if (scenarioType === 'terse') {
    const sentences = countSentences(avaText);
    // Terse caller: reward brevity extra
    scores.tone_match = sentences <= 2 ? 2 : 1;
    if (sentences > 2) notes.push('Response too long for terse caller');
  } else {
    scores.tone_match = 2; // neutral scenarios default pass
  }

  // 5. Brevity (0–1)
  const sentences = countSentences(avaText);
  scores.brevity = sentences <= 2 ? 1 : 0;
  if (sentences > 2) notes.push(`Response too long: ${sentences} sentences`);

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  return { scores, total, notes };
}

function letterGrade(score) {
  if (score >= 9) return 'A';
  if (score >= 7) return 'B';
  if (score >= 5) return 'C';
  return 'F';
}

// ── Test scenarios ────────────────────────────────────────────────────────────

const SCENARIOS = [
  {
    id: 1,
    name: 'The Distressed Caller',
    type: 'distressed',
    turns: [
      "Hi, um, I was in a really bad car accident yesterday and I don't know what to do",
      "Sarah Martinez",
      "My number is 555-0142",
      "A truck ran a red light. I have a broken arm and some back pain",
    ],
    notes: 'Should acknowledge fear/trauma before intake. Use "car accident" not "motor vehicle incident".',
  },
  {
    id: 2,
    name: 'The Terse Caller',
    type: 'terse',
    turns: [
      "Need a lawyer",
      "Mike Johnson",
      "310-555-0198",
      "Slip and fall at work, last week",
    ],
    notes: 'Should match brevity. Skip unnecessary warmth.',
  },
  {
    id: 3,
    name: 'The Venting Caller',
    type: 'neutral',
    turns: [
      "Yeah hi I was rear-ended on the 405 about three weeks ago, the guy came out of nowhere at like 60mph. My name is David Chen and my number is 818-555-0173. I've been seeing a doctor and my neck is really messed up",
    ],
    notes: 'Should NOT re-ask for info already given. Should acknowledge "really messed up".',
  },
  {
    id: 4,
    name: 'The Nervous First-Timer',
    type: 'nervous',
    turns: [
      "Um, hi, I'm not sure if this is the right place to call, but my daughter was hurt at daycare",
      "Rebecca Kim",
      "She fell and they didn't tell us about it for hours. She's only 3.",
    ],
    notes: 'Should reassure before intake questions. Acknowledge how awful it feels.',
  },
  {
    id: 5,
    name: 'The "Are You a Robot?" Challenge',
    type: 'neutral',
    turns: [
      "Wait, am I talking to a real person right now or is this automated?",
      "Okay... I was in a car accident last month and I want to talk to someone",
    ],
    notes: 'Should handle identity challenge naturally. Pivot back into conversation.',
  },
  {
    id: 6,
    name: 'The Early Exit',
    type: 'neutral',
    turns: [
      "Hi, I wanted to ask about a car accident but actually I think I need to call back later, sorry",
    ],
    notes: 'Should let them go graciously. No pushy retention.',
  },
];

// ── Session factory ───────────────────────────────────────────────────────────

function newSession() {
  return {
    callSid: `test-${Date.now()}`,
    transcript: [],
    collected: {
      full_name: '',
      callback_number: '',
      practice_area: '',
      case_summary: '',
      calling_for: '',
      caller_type: null,
    },
    askedQuestionIds: [],
    lastQuestionText: null,
    isUrgent: false,
    callerType: null,
    disclaimerShown: true, // skip greeting for test purposes
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────

const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const CYAN   = '\x1b[36m';

function gradeColor(grade) {
  if (grade === 'A') return GREEN;
  if (grade === 'B') return CYAN;
  if (grade === 'C') return YELLOW;
  return RED;
}

async function runScenario(scenario) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`${BOLD}Scenario ${scenario.id}: ${scenario.name}${RESET}`);
  console.log(`${DIM}${scenario.notes}${RESET}`);
  console.log('─'.repeat(70));

  const session = newSession();
  const turnScores = [];
  let scenarioError = null;

  for (let i = 0; i < scenario.turns.length; i++) {
    const callerText = scenario.turns[i];
    console.log(`\n  ${DIM}Caller:${RESET} "${callerText}"`);

    let parsed;
    try {
      parsed = await callAva({ session, userText: callerText, firmConfig: DEFAULT_FIRM_CONFIG });
    } catch (err) {
      console.log(`  ${RED}ERROR: ${err.message}${RESET}`);
      scenarioError = err.message;
      break;
    }

    const avaText = parsed.next_question_text || '';
    console.log(`  ${BOLD}Ava:${RESET}   "${avaText}"`);

    // Update session state
    session.transcript.push({ role: 'caller', text: callerText });
    session.transcript.push({ role: 'ava', text: avaText });
    session.lastQuestionText = avaText;
    if (parsed.next_question_id && parsed.next_question_id !== 'done') {
      session.askedQuestionIds.push(parsed.next_question_id);
    }
    // Merge extracted fields
    const extracted = parsed.extracted || {};
    for (const key of ['full_name', 'callback_number', 'practice_area', 'case_summary', 'calling_for']) {
      if (extracted[key] && extracted[key].trim()) {
        session.collected[key] = extracted[key].trim();
      }
    }

    const { scores, total, notes } = scoreResponse(avaText, callerText, scenario.type);
    const grade = letterGrade(total);
    const color = gradeColor(grade);

    console.log(`  ${color}Score: ${total}/10 (${grade})${RESET}  [ack:${scores.ack_specificity}/3 | banned:${scores.no_banned_phrases}/2 | phrasing:${scores.question_phrasing}/2 | tone:${scores.tone_match}/2 | brevity:${scores.brevity}/1]`);
    if (notes.length) {
      for (const note of notes) {
        console.log(`  ${YELLOW}  ⚠ ${note}${RESET}`);
      }
    }

    turnScores.push(total);

    // Stop if done
    if (parsed.next_question_id === 'done') {
      console.log(`  ${DIM}(Ava signaled done)${RESET}`);
      break;
    }
  }

  const avg = turnScores.length
    ? turnScores.reduce((a, b) => a + b, 0) / turnScores.length
    : 0;
  const grade = letterGrade(avg);

  return { id: scenario.id, name: scenario.name, avg: avg.toFixed(1), grade, error: scenarioError };
}

async function main() {
  if (!OPENAI_API_KEY) {
    console.error(`${RED}Error: OPENAI_API_KEY is not set in .env${RESET}`);
    process.exit(1);
  }

  console.log(`${BOLD}Ava Voice Quality Test Suite${RESET}`);
  console.log(`Model: ${OPENAI_MODEL}`);
  console.log(`Firm: ${DEFAULT_FIRM_CONFIG.name} (${DEFAULT_FIRM_CONFIG.tone} tone, ${DEFAULT_FIRM_CONFIG.industry})`);

  const results = [];
  for (const scenario of SCENARIOS) {
    const result = await runScenario(scenario);
    results.push(result);
  }

  // Summary table
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${BOLD}SUMMARY${RESET}`);
  console.log('═'.repeat(70));
  console.log(`${'Scenario'.padEnd(40)} ${'Avg'.padEnd(6)} Grade`);
  console.log('─'.repeat(70));

  let grandTotal = 0;
  let count = 0;

  for (const r of results) {
    const color = gradeColor(r.grade);
    const status = r.error ? `${RED}ERROR${RESET}` : `${color}${r.avg} (${r.grade})${RESET}`;
    console.log(`${r.name.padEnd(40)} ${status}`);
    if (!r.error) {
      grandTotal += parseFloat(r.avg);
      count++;
    }
  }

  const overallAvg = count ? (grandTotal / count).toFixed(2) : 'N/A';
  const overallGrade = count ? letterGrade(parseFloat(overallAvg)) : '?';
  const overallColor = gradeColor(overallGrade);

  console.log('─'.repeat(70));
  console.log(`${'Overall average'.padEnd(40)} ${overallColor}${overallAvg} (${overallGrade})${RESET}`);
  console.log('═'.repeat(70));

  const target = 7.5;
  if (count && parseFloat(overallAvg) >= target) {
    console.log(`\n${GREEN}✓ Passes quality bar (≥ ${target})${RESET}`);
  } else if (count) {
    console.log(`\n${RED}✗ Below quality bar (target ≥ ${target}, got ${overallAvg})${RESET}`);
  }
}

main().catch((err) => {
  console.error(`${RED}Fatal: ${err.message}${RESET}`);
  process.exit(1);
});
