// MysqlContainer — a throwaway MySQL 8.4 database for one test file, started with the docker
// CLI (the same approach, and the same reason, as postgres-container.ts: testcontainers-node
// hangs under Bun).
//
// Set METAOBJECTS_TEST_MYSQL_URL (mysql://user:pass@host:port/db) to use an existing server
// instead; the test then creates and drops its own tables in that database.
//
// MySQL's entrypoint runs a temporary server to initialise the data directory, stops it, and
// starts the real one. The temporary server listens on port 0, so readiness is "the final
// server logged `port: 3306`" plus a real connection to the created database.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import mysql from "mysql2/promise";

const URL_ENV = "METAOBJECTS_TEST_MYSQL_URL";
const IMAGE = "mysql:8.4";
const PASSWORD = "test";
const DATABASE = "mo_test";
const READY_DEADLINE_MS = Number(process.env.MO_MYSQL_READY_TIMEOUT_MS ?? 180_000);

export interface MysqlContainerHandle {
  /** `mysql://…` URL for mysql2. */
  url: string;
  stop(): void;
}

export async function startMysql(): Promise<MysqlContainerHandle> {
  const existing = process.env[URL_ENV];
  if (existing !== undefined && existing !== "") return { url: existing, stop: () => {} };

  const name = `metaobjects-mysql-${randomUUID().slice(0, 8)}`;
  const port = await freePort();
  docker(["run", "-d", "--name", name, "-e", `MYSQL_ROOT_PASSWORD=${PASSWORD}`,
    "-e", `MYSQL_DATABASE=${DATABASE}`, "-p", `${port}:3306`, IMAGE]);
  const url = `mysql://root:${PASSWORD}@127.0.0.1:${port}/${DATABASE}`;
  const stop = () => { spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" }); };

  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" });
    const text = `${logs.stdout ?? ""}${logs.stderr ?? ""}`;
    if (text.includes("ready for connections") && text.includes("port: 3306") && (await canConnect(url))) {
      return { url, stop };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const logs = spawnSync("docker", ["logs", "--tail", "40", name], { encoding: "utf8" });
  stop();
  throw new Error(`mysql container ${name} not ready in ${READY_DEADLINE_MS}ms:\n${logs.stdout}${logs.stderr}`);
}

async function canConnect(url: string): Promise<boolean> {
  try {
    const c = await mysql.createConnection(url);
    await c.query("SELECT 1");
    await c.end();
    return true;
  } catch {
    return false;
  }
}

function docker(args: string[]): void {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${r.stderr}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
