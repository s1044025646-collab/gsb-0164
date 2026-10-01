import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { openDatabase } from './db/database.js';
import { Repository } from './db/repository.js';
import { createApiServer, listenLocal } from './api/server.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const repo = new Repository(db);
  const server = createApiServer({ repo });
  const port = await listenLocal(server, config.port);

  const shutdown = (): void => {
    server.close(() => {
      db.close();
      if (existsSync(config.pidFile)) {
        try {
          unlinkSync(config.pidFile);
        } catch {
          /* ignore */
        }
      }
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  writeFileSync(config.pidFile, JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }));
  const line = `FIR lab listening on http://127.0.0.1:${port} (db ${config.dbPath})`;
  console.log(line);
  if (process.env.FIRLAB_PORT_FILE) {
    writeFileSync(process.env.FIRLAB_PORT_FILE, String(port));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

export { readFileSync };
