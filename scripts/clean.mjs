// Manage only this project's data/tmp directories and a locally recorded PID.
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const targets = [resolve(root, 'data'), resolve(root, 'tmp')];
const pidFile = resolve(root, 'tmp', 'server.pid');

if (existsSync(pidFile)) {
  try {
    const { pid } = JSON.parse(readFileSync(pidFile, 'utf8'));
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`stopped firlab server pid=${pid}`);
      } catch {
        console.log(`pid ${pid} not running`);
      }
    }
  } catch {
    /* ignore malformed pid file */
  }
}

for (const dir of targets) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`removed ${dir}`);
  }
}
