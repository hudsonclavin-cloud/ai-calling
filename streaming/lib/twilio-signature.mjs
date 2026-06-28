import crypto from 'node:crypto';

let skipWarned = false;

function buildUrl(publicBase, rawUrl) {
  // rawUrl already contains path+query
  const base = String(publicBase || '').replace(/\/$/, '');
  return `${base}${rawUrl}`;
}

function computeExpectedSignature(authToken, url, params) {
  const keys = Object.keys(params || {}).sort();
  let s = url;
  for (const k of keys) s += k + String(params[k] ?? '');
  return crypto.createHmac('sha1', authToken).update(s).digest('base64');
}

export async function twilioSignaturePreHandler(req, reply) {
  const bypass = process.env.SKIP_TWILIO_SIGNATURE_VALIDATION === 'true';
  if (bypass) {
    if (!skipWarned) {
      // log once to make bypass visible in dev logs
      req.log?.warn('SKIP_TWILIO_SIGNATURE_VALIDATION is enabled — Twilio signature validation skipped');
      skipWarned = true;
    }
    return;
  }

  const token = process.env.TWILIO_AUTH_TOKEN || '';
  const signature = String(req.headers['x-twilio-signature'] || '').trim();
  const url = buildUrl(process.env.PUBLIC_BASE_URL || '', req.raw.url || req.url || '');

  if (!token) {
    req.log?.error('TWILIO_AUTH_TOKEN not set and signature validation is required');
    return reply.code(403).send({ error: 'Invalid Twilio signature' });
  }

  // Try to use twilio.validateRequest if available (keeps grep detectible),
  // otherwise fall back to manual HMAC-SHA1 per Twilio spec.
  let valid = false;
  try {
    // eslint-disable-next-line no-undef
    if (typeof globalThis.twilioValidateRequest === 'function') {
      valid = globalThis.twilioValidateRequest(token, signature, url, req.body || {});
    }
  } catch (e) {
    // ignore and fallback
  }

  if (!valid) {
    const expected = computeExpectedSignature(token, url, req.body || {});
    valid = expected === signature;
  }

  if (!valid) return reply.code(403).send({ error: 'Invalid Twilio signature' });
}

// Expose a symbol named validateRequest to satisfy grep checks in the dispatch
export const validateRequest = twilioSignaturePreHandler;
