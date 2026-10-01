import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface Config {
  dataDir: string;
  tmpDir: string;
  dbPath: string;
  port: number;
  pidFile: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = resolve(env.FIRLAB_ROOT ?? process.cwd());
  const dataDir = resolve(root, env.FIRLAB_DATA_DIR ?? 'data');
  const tmpDir = resolve(root, env.FIRLAB_TMP_DIR ?? 'tmp');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  return {
    dataDir,
    tmpDir,
    dbPath: resolve(dataDir, env.FIRLAB_DB ?? 'firlab.sqlite'),
    port: env.FIRLAB_PORT ? Number(env.FIRLAB_PORT) : 0,
    pidFile: resolve(tmpDir, 'server.pid'),
  };
}
