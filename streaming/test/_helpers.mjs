import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

export async function setupTestApp() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ava-test-'));
  process.env.DATA_DIR = tmp;
  process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://127.0.0.1:3000';
  const mod = await import('../server.mjs');
  const app = mod.app;
  return { app, tmpDir: tmp };
}
