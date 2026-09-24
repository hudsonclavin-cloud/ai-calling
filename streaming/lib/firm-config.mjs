export const FIRM_ID_PATTERN = /^(?:firm|sim)_[a-z0-9](?:[a-z0-9_]{0,62})$/;

export const SUPPORTED_INDUSTRIES = new Set([
  'law_pi',
  'law_family',
  'law_criminal',
  'medical',
  'real_estate',
  'home_services',
  'financial_services',
  'general',
]);

const ALLOWED_FIELDS = new Set([
  'id', 'name', 'ava_name', 'tone', 'industry', 'opening', 'closing',
  'practice_areas', 'required_fields', 'question_overrides', 'acknowledgments',
  'max_questions', 'max_reprompts', 'office_hours', 'business_hours', 'timezone',
  'disclaimer', 'intake_rules', 'notification_email', 'notification_phone',
  'twilio_phone', 'webhook_url', 'contact_name', 'contact_email', 'greeting_style',
  'custom_intro', 'reprompt_phrases', 'early_exit_phrases', 'urgency_phrases',
  'stripe_customer_id', 'stripe_subscription_id', 'billing_status', 'status',
  'trial_ends_at', 'trial_warning_sent',
]);

const MAX_LENGTH = {
  name: 120,
  ava_name: 40,
  opening: 600,
  closing: 600,
  office_hours: 200,
  disclaimer: 1000,
  intake_rules: 2000,
  notification_email: 254,
  notification_phone: 32,
  twilio_phone: 32,
  webhook_url: 2048,
  contact_name: 120,
  contact_email: 254,
};

export function assertFirmId(value) {
  const id = String(value || '').trim();
  if (!FIRM_ID_PATTERN.test(id)) {
    const error = new Error('firm id must start with "firm_" and contain only lowercase letters, numbers, and underscores (max 68 characters)');
    error.statusCode = 400;
    throw error;
  }
  return id;
}

function cleanString(value, key) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  const result = value.replace(/\0/g, '').trim();
  if (result.length > (MAX_LENGTH[key] || 500)) throw new Error(`${key} is too long`);
  return result;
}

function cleanStringArray(value, key, maxItems = 30) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  if (value.length > maxItems) throw new Error(`${key} has too many items`);
  return [...new Set(value.map((item) => cleanString(item, key)).filter(Boolean))];
}

/** Validate and normalize a complete tenant configuration before it reaches disk. */
export function normalizeFirmConfig(input, firmId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('request body must be an object');
  const id = assertFirmId(firmId);
  const unknown = Object.keys(input).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length) throw new Error(`unsupported configuration fields: ${unknown.join(', ')}`);

  const result = { ...input, id };
  for (const key of Object.keys(MAX_LENGTH)) {
    if (key in result) result[key] = cleanString(result[key], key);
  }
  if (!result.name) throw new Error('name is required');
  if (!result.ava_name) throw new Error('ava_name is required');
  if (!SUPPORTED_INDUSTRIES.has(result.industry)) throw new Error(`unsupported industry: ${result.industry}`);
  if (!['warm', 'professional', 'friendly'].includes(result.tone)) throw new Error(`unsupported tone: ${result.tone}`);

  result.practice_areas = cleanStringArray(result.practice_areas || [], 'practice_areas');
  if (!result.practice_areas.length) throw new Error('at least one service area is required');
  result.required_fields = cleanStringArray(result.required_fields || [], 'required_fields', 12);
  result.acknowledgments = cleanStringArray(result.acknowledgments || [], 'acknowledgments', 20);

  if (!result.question_overrides || typeof result.question_overrides !== 'object' || Array.isArray(result.question_overrides)) {
    throw new Error('question_overrides must be an object');
  }
  result.question_overrides = Object.fromEntries(
    Object.entries(result.question_overrides).map(([key, value]) => [key, cleanString(value, 'question_overrides')])
  );

  result.max_questions = Number(result.max_questions);
  result.max_reprompts = Number(result.max_reprompts);
  if (!Number.isInteger(result.max_questions) || result.max_questions < 4 || result.max_questions > 20) throw new Error('max_questions must be an integer from 4 to 20');
  if (!Number.isInteger(result.max_reprompts) || result.max_reprompts < 1 || result.max_reprompts > 5) throw new Error('max_reprompts must be an integer from 1 to 5');

  if (result.notification_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.notification_email)) throw new Error('notification_email is invalid');
  if (result.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.contact_email)) throw new Error('contact_email is invalid');
  if (result.webhook_url) {
    let url;
    try { url = new URL(result.webhook_url); } catch { throw new Error('webhook_url is invalid'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('webhook_url must use http or https');
  }
  return result;
}
