import assert from 'node:assert/strict';
import crypto from 'node:crypto';

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

const base = {
  ELEVEN_STABILITY: '0.55',
  ELEVEN_SIMILARITY: '0.75',
  ELEVEN_STYLE: '0.10',
  ELEVEN_SPEED: '1.00',
};
const input = { voiceId: 'voice_1', modelId: 'eleven_turbo_v2_5', text: 'Hello there.' };

assert.notEqual(
  makeTtsCacheKey({ ...input, settings: getVoiceSettings(base) }),
  makeTtsCacheKey({ ...input, settings: getVoiceSettings({ ...base, ELEVEN_STABILITY: '0.56' }) }),
  'cache key changes when ELEVEN_STABILITY changes',
);

assert.notEqual(
  makeTtsCacheKey({ ...input, settings: getVoiceSettings(base) }),
  makeTtsCacheKey({ ...input, settings: getVoiceSettings({ ...base, ELEVEN_STYLE: '0.11' }) }),
  'cache key changes when ELEVEN_STYLE changes',
);

assert.equal(
  getVoiceSettings({ ...base, ELEVEN_STYLE: '0' }).style,
  0,
  'ELEVEN_STYLE="0" yields style 0',
);

assert.equal(
  makeTtsCacheKey({ ...input, settings: getVoiceSettings(base) }),
  makeTtsCacheKey({ ...input, settings: getVoiceSettings({ ...base }) }),
  'identical env yields identical key',
);

console.log('verify-voice-settings: all 4 assertions passed');
