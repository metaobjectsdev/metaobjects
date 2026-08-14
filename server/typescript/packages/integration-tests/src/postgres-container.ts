// PostgresContainer — obtain a fresh, isolated Postgres database per scenario.
//
// Two modes:
//   1. Shared sidecar (CI): if METAOBJECTS_TEST_PG_URL is set, connect to that
//      already-running Postgres and CREATE a uniquely-named database per call
//      (dropping it on stop). No container boot / image pull on the hot path —
//      the whole point of the shared `services: postgres` CI sidecar. Each
//      scenario still gets a pristine empty database, so isolation is identical
//      to the per-container path.
//   2. Per-container (local dev): with no env var, boot a fresh container via
//      the docker CLI, exactly as before.
//
// Implementation note (mode 2): testcontainers-node 10.x hangs on `start()`
// under Bun even though the container itself comes up healthy (verified:
// container ready in <1s, but the promise never resolves). The hand-managed
// docker-CLI path here is small, fast, and avoids the bun/testcontainers compat
// issue entirely. When testcontainers-node + bun is fixed upstream, swap in
// `@testcontainers/postgresql` (deps for it are already declared). The shared
// sidecar mode sidesteps this entirely; the fallback keeps the docker path.
//
// Readiness gating (mode 2): postgres' first-boot entrypoint starts the server
// twice (initial init, then the real boot). `pg_isready` can return success
// during the first window, so we additionally verify a real client connection
// from the host succeeds before returning.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "pg";

/** Env var naming the shared CI Postgres sidecar (admin URL). Unset = per-container fallback. */
const SHARED_PG_URL_ENV = "METAOBJECTS_TEST_PG_URL";

/** Per-attempt connect timeout so a stalled connection fails fast instead of
 *  hanging (pg's default has no client-side connect timeout). */
const CONNECT_TIMEOUT_MS = 10_000;
/** Total budget for the shared sidecar to start answering real connections. Kept
 *  under the scenarios' 60s test timeout so the retry loop has headroom to succeed
 *  (and to leave time for CREATE DATABASE + server boot) rather than racing it. */
const SHARED_READY_DEADLINE_MS = 45_000;

export interface RunningPg {
  readonly connectionUri: string;
  stop(): Promise<void>;
}

export async function startPostgres(image = "postgres:16-alpine"): Promise<RunningPg> {
  const sharedUrl = process.env[SHARED_PG_URL_ENV];
  if (sharedUrl) return startOnSharedPostgres(sharedUrl);

  // PORT RACE. pickFreePort() closes its probe socket and hands the number to docker,
  // which binds it LATER -- a check-then-act gap. Alone it never bites; under a full CI
  // run several ports start containers at once and two can be handed the same number.
  // The loser's container is created and then dies, and a readiness probe that only
  // asks `docker exec` cannot tell that from a slow boot. Retry on a FRESH port.
  //
  // Deliberately NOT `--rm`: an auto-removed container takes its logs with it, so the
  // one artefact explaining the failure vanishes exactly when it is needed. stop()
  // force-removes, so nothing leaks.
  const name = `metaobjects-test-${randomUUID().slice(0, 8)}`;
  const forceRemove = (): void => { try { runDocker(["rm", "-f", name]); } catch { /* already gone */ } };
  let lastFailure: unknown;
  for (let attempt = 1; attempt <= PG_START_ATTEMPTS; attempt++) {
    const port = await pickFreePort();
    try {
      runDocker([
        "run", "-d",
        "--name", name,
        "-e", "POSTGRES_PASSWORD=test",
        "-p", `${port}:5432`,
        image,
      ]);
    } catch (e) {
      lastFailure = e;   // docker refused the bind outright — the cleanest form of the race
      forceRemove();
      continue;
    }
    const connectionUri = `postgres://postgres:test@localhost:${port}/postgres`;
    try {
      await waitForPgReady(name, connectionUri);
      return { connectionUri, stop: async () => { forceRemove(); } };
    } catch (e) {
      lastFailure = e;
      forceRemove();
    }
  }
  throw new Error(
    `postgres container '${name}' failed to start in ${PG_START_ATTEMPTS} attempts: ${String(lastFailure)}`,
  );
}

// Shared-sidecar mode: create a fresh, uniquely-named database on the already
// running Postgres named by the URL, hand back a URL pointing at it, and drop it
// on stop. A dedicated database per scenario preserves the per-container path's
// "pristine empty DB" isolation.
async function startOnSharedPostgres(adminUri: string): Promise<RunningPg> {
  // Gate on a REAL connection before doing anything. The CI `services: postgres`
  // health-check uses `pg_isready`, which — like the per-container path documents
  // (waitForPgReady) — can report success during postgres' first-boot init window;
  // and under CI host contention the server can be transiently slow to accept
  // connections. Without this gate the first admin.connect() below hangs until the
  // scenario's 60s test timeout (the intermittent ts-integration flake). Retrying a
  // short-timeout probe waits the sidecar out gracefully instead.
  await waitForSharedReady(adminUri);

  const dbName = `mo_test_${randomUUID().replace(/-/g, "")}`;
  const admin = new Client({ connectionString: adminUri, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await admin.connect();
  try {
    // Identifier is a fixed-shape generated name (no user input) — safe to inline.
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }
  const connectionUri = withDatabase(adminUri, dbName);
  return {
    connectionUri,
    stop: async () => {
      const drop = new Client({ connectionString: adminUri, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
      await drop.connect();
      try {
        await drop.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      } finally {
        await drop.end();
      }
    },
  };
}

// Poll a real client connection to the shared sidecar until it answers or the
// deadline elapses — the shared-mode analogue of waitForPgReady (mode 2). Cheap
// (~ms) when the sidecar is already healthy; only retries when it is genuinely slow.
async function waitForSharedReady(adminUri: string): Promise<void> {
  const deadline = Date.now() + SHARED_READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await canConnect(adminUri)) return;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(
    `shared Postgres sidecar (${SHARED_PG_URL_ENV}) did not accept a connection within ${SHARED_READY_DEADLINE_MS / 1000}s`,
  );
}

/** Replace the database (path) component of a postgres:// URL. */
function withDatabase(uri: string, dbName: string): string {
  const u = new URL(uri);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function runDocker(args: string[]): string {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

// Postgres' first-boot entrypoint starts the server twice (initial init, then
// the real boot). `pg_isready` can return success during the first window, so
// we additionally verify a real client connection from the host succeeds.
// READINESS WINDOW. 30s was too tight: under a FULL local-CI run several ports spin
// their own Postgres concurrently, and a container that is merely slow to boot
// produces a red gate indistinguishable from a real failure -- it fires BEFORE any
// test logic. Raising the bound costs nothing when the container is ready quickly
// (this polls every 250ms and returns immediately) and only changes how long the
// pathological case takes to give up.
const PG_READY_TIMEOUT_S = Number(process.env["MO_PG_READY_TIMEOUT_S"] ?? "120");
/** Fresh-port retries before giving up — see the port-race note in startPostgres(). */
const PG_START_ATTEMPTS = 3;

async function waitForPgReady(name: string, uri: string): Promise<void> {
  const deadline = Date.now() + PG_READY_TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    // FAIL FAST ON A DEAD CONTAINER. `docker exec` alone cannot tell "still booting"
    // from "exited seconds ago" — both just fail — so a container that died on startup
    // used to burn the whole window and report a TIMEOUT, which reads as slowness and
    // is not. Ask docker for its state, and surface its logs: that is the real reason.
    const state = inspectState(name);
    if (state !== "running") {
      throw new Error(
        `postgres container '${name}' is '${state}', not running — it died during startup `
        + `rather than being slow. docker logs:\n${tailLogs(name)}`,
      );
    }
    const r = spawnSync("docker", ["exec", name, "pg_isready", "-U", "postgres"], { encoding: "utf8" });
    if (r.status === 0 && (await canConnect(uri))) return;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(
    `postgres container '${name}' did not become ready within ${PG_READY_TIMEOUT_S}s `
    + `(state=${inspectState(name)}). docker logs:\n${tailLogs(name)}`,
  );
}

/** The container's docker state, or "gone" when it cannot be determined. */
function inspectState(name: string): string {
  const r = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", name], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "gone";
}

/** Last few log lines, for an error that would otherwise name only a symptom. */
function tailLogs(name: string): string {
  const r = spawnSync("docker", ["logs", "--tail", "40", name], { encoding: "utf8" });
  return r.status === 0 ? `${r.stdout}${r.stderr}`.trim() : "(docker logs unavailable)";
}

async function canConnect(uri: string): Promise<boolean> {
  const client = new Client({ connectionString: uri, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
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
