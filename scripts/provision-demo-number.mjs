#!/usr/bin/env node
/**
 * provision-demo-number.mjs
 * Purchases a US local Twilio number and configures it for the firm_demo webhook.
 *
 * Usage:
 *   TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... PUBLIC_BASE_URL=... node scripts/provision-demo-number.mjs
 *
 * After running, set the printed number as DEMO_PHONE_NUMBER in your .env file.
 */

import 'dotenv/config';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !PUBLIC_BASE_URL) {
  console.error('Missing required env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_BASE_URL');
  process.exit(1);
}

const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
const baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}`;

async function twilioRequest(path, method = 'GET', body = null) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${auth}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body: new URLSearchParams(body).toString() } : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Twilio ${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// 1. Search available US local numbers
console.log('Searching for available US local numbers...');
const available = await twilioRequest('/AvailablePhoneNumbers/US/Local.json?SmsEnabled=false&Limit=1');
const candidate = available?.available_phone_numbers?.[0];
if (!candidate) {
  console.error('No available numbers found.');
  process.exit(1);
}
console.log(`Found: ${candidate.phone_number} (${candidate.friendly_name})`);

// 2. Purchase the number
console.log('Purchasing number...');
const purchased = await twilioRequest('/IncomingPhoneNumbers.json', 'POST', {
  PhoneNumber: candidate.phone_number,
  FriendlyName: 'Ava Demo Line',
});
const sid = purchased.sid;
console.log(`Purchased: ${purchased.phone_number} (SID: ${sid})`);

// 3. Configure voice webhook
const voiceUrl = `${PUBLIC_BASE_URL}/twiml?firmId=firm_demo`;
console.log(`Configuring voice webhook: ${voiceUrl}`);
await twilioRequest(`/IncomingPhoneNumbers/${sid}.json`, 'POST', {
  VoiceUrl: voiceUrl,
  VoiceMethod: 'POST',
});

console.log('\n✅ Demo number provisioned successfully!');
console.log(`\nAdd this to your .env:\n  DEMO_PHONE_NUMBER=${purchased.phone_number}`);
