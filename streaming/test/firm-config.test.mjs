import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFirmId, normalizeFirmConfig } from '../lib/firm-config.mjs';

const valid = {
  name: 'North Star Plumbing', ava_name: 'Maya', tone: 'friendly', industry: 'home_services',
  practice_areas: ['Emergency plumbing'], required_fields: ['full_name', 'callback_number'],
  question_overrides: { practice_area: 'What service do you need?' }, acknowledgments: ['Got it.'],
  max_questions: 8, max_reprompts: 2,
};

test('firm IDs cannot escape the tenant config directory', () => {
  assert.throws(() => assertFirmId('../../secrets'), /firm id/);
  assert.throws(() => assertFirmId('firm_Acme'), /firm id/);
  assert.equal(assertFirmId('firm_north_star'), 'firm_north_star');
});

test('normalizes a non-legal business configuration', () => {
  const result = normalizeFirmConfig({ ...valid, practice_areas: [' Emergency plumbing ', 'Emergency plumbing'] }, 'firm_north_star');
  assert.equal(result.industry, 'home_services');
  assert.deepEqual(result.practice_areas, ['Emergency plumbing']);
  assert.equal(result.id, 'firm_north_star');
});

test('rejects unsupported industries and unrecognized fields', () => {
  assert.throws(() => normalizeFirmConfig({ ...valid, industry: 'astrology' }, 'firm_star'), /unsupported industry/);
  assert.throws(() => normalizeFirmConfig({ ...valid, api_secret: 'nope' }, 'firm_star'), /unsupported configuration fields/);
});
