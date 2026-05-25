// PostgresContainer — start a fresh Postgres testcontainer per scenario.
//
// Implementation note: testcontainers-node 10.x hangs on `start()` under Bun
// even though the container itself comes up healthy (verified: container ready
// in <1s, but the promise never resolves). The hand-managed docker-CLI path
// here is small, fast, and avoids the bun/testcontainers compat issue entirely.
// When testcontainers-node + bun is fixed upstream, swap in
// `@testcontainers/postgresql` (deps for it are already declared).
//
// Readiness gating: postgres' first-boot entrypoint starts the server twice
// (initial init, then the real boot). `pg_isready` can return success during
// the first window, so we additionally verify a real client connection from
// the host succeeds before returning.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "pg";

export interface RunningPg {
  readonly connectionUri: string;
  stop(): Promise<void>;
}

export async function startPostgres(image = "postgres:16-alpine"): Promise<RunningPg> {
  const name = `metaobjects-test-${randomUUID().slice(0, 8)}`;
  const port = await pickFreePort();
  runDocker([
    "run", "-d", "--rm",
    "--name", name,
    "-e", "POSTGRES_PASSWORD=test",
    "-p", `${port}:5432`,
    image,
  ]);
  const connectionUri = `postgres://postgres:test@localhost:${port}/postgres`;
  await waitForPgReady(name, connectionUri);
  return {
    connectionUri,
    stop: async () => { runDocker(["rm", "-f", name]); },
  };
}

function runDocker(args: string[]): string {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

// Postgres' first-boot entrypoint starts the server twice (initial init, then
// the real boot). `pg_isready` can return success during the first window, so
// we additionally verify a real client connection from the host succeeds.
async function waitForPgReady(name: string, uri: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const r = spawnSync("docker", ["exec", name, "pg_isready", "-U", "postgres"], { encoding: "utf8" });
    if (r.status === 0 && (await canConnect(uri))) return;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`postgres container '${name}' did not become ready within 30s`);
}

async function canConnect(uri: string): Promise<boolean> {
  const client = new Client({ connectionString: uri });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    try { await client.end(); } catch { /* ignore */ }
  }
}

// Bind ephemeral, read assigned port, close. Race-free enough for serial
// scenarios (we don't run parallel containers).
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else reject(new Error("could not pick free port"));
    });
  });
}
