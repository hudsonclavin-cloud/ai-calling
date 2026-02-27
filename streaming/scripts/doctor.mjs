import { execSync } from 'node:child_process';

const port = process.env.PORT || 5050;

function mask(value) {
  if (!value) return '(missing)';
  const str = String(value);
  if (str.length <= 8) return '********';
  return `${str.slice(0, 4)}…${str.slice(-4)}`;
}

console.log('node', process.version);
console.log('PUBLIC_BASE_URL', process.env.PUBLIC_BASE_URL || '(missing)');
console.log('ELEVENLABS_API_KEY', mask(process.env.ELEVENLABS_API_KEY));
console.log('ELEVENLABS_VOICE_ID', mask(process.env.ELEVENLABS_VOICE_ID));

try {
  const output = execSync(`lsof -ti tcp:${port}`).toString().trim();
  console.log('port', port, output ? `in use by ${output}` : 'free');
} catch {
  console.log('port', port, 'free');
}

try {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const text = await res.text();
  console.log('/health', res.status, text);
} catch (err) {
  console.log('/health error', err?.message || String(err));
}
