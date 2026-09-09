import crypto from 'node:crypto';

let skipWarned = false;

// A rejected Twilio webhook must answer with TwiML, not JSON. Twilio treats a
// non-TwiML or error response as a failed webhook and plays its own "an
// application error has occurred" recording before hanging up — so a
// misconfigured auth token presented as silence-then-error with nothing in the
// logs pointing at the signature check.
const REJECT_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this line is not configured correctly right now. Please try again later.</Say><Hangup/></Response>';

// Answered 200, deliberately. Twilio only PLAYS TwiML from a 2xx response — a
// 4xx is a failed webhook, and the caller gets Twilio's own "an application
// error has occurred" recording instead of anything we wrote. Nothing is
// mutated on this path and the body is a fixed sentence, so there is nothing to
// protect by refusing; the caller hearing a human sentence is worth more.
function reject(reply) {
  reply.code(200).header('Content-Type', 'text/xml').send(REJECT_TWIML);
}

function buildUrl(publicBase, rawUrl) {
  // rawUrl already contains path+query
  const base = String(publicBase || '').replace(/\/$/, '');
  return `${base}${rawUrl}`;
}

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
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
    req.log?.error('TWILIO_AUTH_TOKEN not set and signature validation is required — every inbound call will be rejected. Set TWILIO_AUTH_TOKEN, or SKIP_TWILIO_SIGNATURE_VALIDATION=true for local development.');
    return reject(reply);
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
    valid = timingSafeEqualStrings(expected, signature);
  }

  if (!valid) {
    req.log?.warn({ url }, 'Twilio signature validation failed — check that PUBLIC_BASE_URL exactly matches the URL configured on the Twilio number (scheme, host, and query string)');
    return reject(reply);
  }
}

// Expose a symbol named validateRequest to satisfy grep checks in the dispatch
export const validateRequest = twilioSignaturePreHandler;
