import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHandler } from "./api.ts";
import { openDb } from "./db.ts";

export interface ServerInfo {
  port: number;
  close: () => Promise<void>;
}

export async function startServer(dbPath = "data/fir.sqlite", host = "127.0.0.1"): Promise<ServerInfo> {
  const absolute = resolve(dbPath);
  mkdirSync(dirname(absolute), { recursive: true });
  const db = openDb(absolute);
  const server = createServer(createHandler(db));
  await new Promise<void>((resolveStart) => {
    // port 0 -> OS assigns a free ephemeral port; host is loopback only.
    server.listen(0, host, () => resolveStart());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind local server");
  }
  const port = address.port;
  console.log(`[fir-flow] listening on http://${host}:${port} (db: ${absolute})`);
  return {
    port,
    close: () =>
      new Promise<void>((closeResolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else {
            db.close();
            closeResolve();
          }
        });
      }),
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath.endsWith("server.ts") || invokedPath.endsWith("server.js")) {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
