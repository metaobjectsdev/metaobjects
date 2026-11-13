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
//
// Every docker call made while the container starts is asynchronous and bounded. A blocking
// spawnSync inside a test worker that `bun test --parallel` is running under heavy load could
// miss its child's exit and spin the worker at full CPU indefinitely, holding the integration
// lane open for hours (observed with the readiness poll's repeated `docker logs`). An async
// child that the runner kills just rejects, and the hook fails on its own timeout.

import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { reaperLabelArgs } from "./test-reaper.ts";
import mysql from "mysql2/promise";

const URL_ENV = "METAOBJECTS_TEST_MYSQL_URL";
const IMAGE = "mysql:8.4";
const PASSWORD = "test";
const DATABASE = "mo_test";
const READY_DEADLINE_MS = Number(process.env.MO_MYSQL_READY_TIMEOUT_MS ?? 180_000);
/** One docker CLI call; a pull of the image on first use is the slow case. */
const DOCKER_CALL_TIMEOUT_MS = 120_000;

export interface MysqlContainerHandle {
  /** `mysql://…` URL for mysql2. */
  url: string;
  stop(): void;
}

export async function startMysql(): Promise<MysqlContainerHandle> {
  const existing = process.env[URL_ENV];
  if (existing !== undefined && existing !== "") return { url: existing, stop: () => {} };

  const name = `metaobjects-mysql-${randomUUID().slice(0, 8)}`;
  // Teardown is one quick call after the tests, the same as postgres-container.ts.
  const stop = () => { spawnSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore", timeout: 60_000 }); };
  // Docker assigns the host port at bind time; see the port note in postgres-container.ts.
  let url: string;
  try {
    await docker(["run", "-d", ...(await reaperLabelArgs()), "--name", name, "-e", `MYSQL_ROOT_PASSWORD=${PASSWORD}`,
      "-e", `MYSQL_DATABASE=${DATABASE}`, "-p", "127.0.0.1::3306", IMAGE, "--innodb-use-native-aio=0"]);
    url = `mysql://root:${PASSWORD}@127.0.0.1:${await publishedPort(name)}/${DATABASE}`;
  } catch (e) {
    stop();
    throw e;
  }

  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    const text = await docker(["logs", name]).catch(() => "");
    if (text.includes("ready for connections") && text.includes("port: 3306") && (await canConnect(url))) {
      return { url, stop };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const logs = await docker(["logs", "--tail", "40", name]).catch((e: unknown) => String(e));
  stop();
  throw new Error(`mysql container ${name} not ready in ${READY_DEADLINE_MS}ms:\n${logs}`);
}

/** The host port docker bound to the container's 3306, as `docker port` prints it. */
async function publishedPort(name: string): Promise<number> {
  const out = await docker(["port", name, "3306/tcp"]);
  const m = /:(\d+)\s*$/m.exec(out.split("\n")[0] ?? "");
  if (m === null) throw new Error(`docker port ${name} 3306/tcp printed no port: '${out}'`);
  return Number(m[1]);
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

/** Runs one docker CLI call and resolves its stdout and stderr together (`docker logs` writes
 *  the server's log to stderr); rejects on a non-zero exit or after the call timeout. */
function docker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { encoding: "utf8", timeout: DOCKER_CALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`docker ${args.join(" ")} failed: ${stderr || error.message}`));
        else resolve(`${stdout}${stderr}`);
      });
  });
}
