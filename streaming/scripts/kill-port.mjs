import { execSync } from 'node:child_process';

const port = process.env.PORT || 5050;

try {
  const output = execSync(`lsof -ti tcp:${port}`).toString().trim();
  if (output) {
    execSync(`kill -9 ${output}`);
    console.log(`killed ${output}`);
  } else {
    console.log(`no process on port ${port}`);
  }
} catch {
  console.log(`no process on port ${port}`);
}
