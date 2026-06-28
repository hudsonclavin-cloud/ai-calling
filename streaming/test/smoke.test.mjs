import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestApp } from './_helpers.mjs';

test('smoke: /health returns 200', async () => {
  const { app } = await setupTestApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
});
