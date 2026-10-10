// CubeStack — a throwaway Cube instance over a throwaway Postgres, for the cube-model live check
// (FR-044 Plan 4, Task 7; cube-live/cube-model.live.ts).
//
// Everything runs through the docker CLI, as postgres-container.ts and mysql-container.ts do (and
// for their reason: testcontainers-node hangs under Bun). One run owns:
//
//   * a private network `mo-cube-<random>`;
//   * `postgres:16-alpine` on it with NO published port. The test reaches it only through
//     `docker exec … psql`, so nothing it does can collide with another Postgres on this host,
//     and the shared Postgres sidecar (ci-local.sh) is never touched;
//   * `cubejs/cube:v1.7.43` in development mode on the same network, its API published on an
//     EPHEMERAL port bound to 127.0.0.1 (`-p 127.0.0.1::4000`, read back with `docker port`),
//     with the model directory bind-mounted read-only at /cube/conf/model. Development mode turns
//     off API auth and recompiles the model when the mounted files change.
//
// `stop()` force-removes both containers and the network. It runs from the caller's afterAll AND
// from every failure path inside startCubeStack, so a run that dies half-way leaves nothing behind.
// Containers are deliberately not `--rm`: an auto-removed container takes its logs with it, and
// the logs are what explains a failure.
//
// The image is about 1 GB. It is pulled (when absent) BEFORE the readiness clock starts, with its
// own 15-minute budget, so a slow pull is never reported as a slow Cube.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export const CUBE_IMAGE = "cubejs/cube:v1.7.43";
export const CUBE_POSTGRES_IMAGE = "postgres:16-alpine";

/** Prefix of every container and network a run creates; the leftover check filters on it. */
export const CUBE_RESOURCE_PREFIX = "mo-cube-";

/** Seconds Cube gets to answer `/v1/meta` once its container is started. */
const READY_TIMEOUT_S = Number(process.env["MO_CUBE_READY_TIMEOUT_S"] ?? "300");
/** Seconds the throwaway Postgres gets to accept a TCP connection inside its container. */
const PG_READY_TIMEOUT_S = Number(process.env["MO_PG_READY_TIMEOUT_S"] ?? "120");
/** Budget for one `docker pull`, outside the readiness clock. */
const PULL_TIMEOUT_MS = 15 * 60_000;
/** Per-request timeout for a readiness probe, so a stalled socket cannot eat the deadline. */
const PROBE_TIMEOUT_MS = 10_000;

const PG_PASSWORD = "test";

/** The longest startCubeStack can take: two pulls, then both readiness windows. A hook's timeout. */
export function cubeStackStartBudgetMs(): number {
  return 2 * PULL_TIMEOUT_MS + (PG_READY_TIMEOUT_S + READY_TIMEOUT_S) * 1000;
}

export interface CubeStack {
  /** `http://127.0.0.1:<port>/cubejs-api/v1`. */
  readonly apiBase: string;
  readonly network: string;
  readonly pgContainer: string;
  readonly cubeContainer: string;
  /** Run SQL through `psql` inside the Postgres container (ON_ERROR_STOP, quiet, unaligned, tuples only). */
  psql(sqlText: string): string;
  /** The last `lines` lines of the Cube container's log, for a failure message. */
  cubeLogs(lines?: number): string;
  /** Force-remove both containers and the network. Idempotent; never throws. */
  stop(): void;
}

export type CubeStackStart =
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "running"; readonly stack: CubeStack };

/** Why docker cannot be used here, or undefined when `docker info` answers. */
export function dockerUnavailableReason(): string | undefined {
  const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 60_000 });
  if (r.error !== undefined) return `docker info failed to run: ${r.error.message}`;
  if (r.status !== 0) return `docker info exited ${String(r.status)}: ${firstLine(r.stderr || r.stdout)}`;
  return undefined;
}

/**
 * Start Postgres and Cube on a private network, Cube reading `modelDir` (the directory that
 * holds `cubes/`). Returns `skipped` when docker is unavailable; throws, after removing
 * everything it created, when any step fails.
 */
export async function startCubeStack(modelDir: string): Promise<CubeStackStart> {
  const unavailable = dockerUnavailableReason();
  if (unavailable !== undefined) return { kind: "skipped", reason: unavailable };

  // Outside the clock: a pinned tag already present is used as is.
  await ensureImage(CUBE_POSTGRES_IMAGE);
  await ensureImage(CUBE_IMAGE);

  const id = randomUUID().slice(0, 8);
  const network = `${CUBE_RESOURCE_PREFIX}${id}`;
  const pgContainer = `${network}-pg`;
  const cubeContainer = `${network}-cube`;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    process.off("exit", stop);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    // Containers first: a network with an attached container cannot be removed. `-v` takes the
    // postgres image's anonymous data volume with its container.
    spawnSync("docker", ["rm", "-f", "-v", cubeContainer, pgContainer], { stdio: "ignore", timeout: 120_000 });
    spawnSync("docker", ["network", "rm", network], { stdio: "ignore", timeout: 60_000 });
  };
  // An interrupted run (Ctrl-C, a cancelled job) is an exit path too: remove what this run
  // created, then exit as the signal would have.
  const onSignal = (signal: NodeJS.Signals): void => {
    stop();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("exit", stop);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    docker(["network", "create", network]);
    docker(["run", "-d", "--name", pgContainer, "--network", network,
      "-e", `POSTGRES_PASSWORD=${PG_PASSWORD}`, CUBE_POSTGRES_IMAGE]);
    await waitForPostgres(pgContainer);

    docker([
      "run", "-d", "--name", cubeContainer, "--network", network,
      "-p", "127.0.0.1::4000",
      "-e", "CUBEJS_DB_TYPE=postgres",
      "-e", `CUBEJS_DB_HOST=${pgContainer}`,
      "-e", "CUBEJS_DB_PORT=5432",
      "-e", "CUBEJS_DB_NAME=postgres",
      "-e", "CUBEJS_DB_USER=postgres",
      "-e", `CUBEJS_DB_PASS=${PG_PASSWORD}`,
      "-e", "CUBEJS_DEV_MODE=true",
      "-e", "CUBEJS_TELEMETRY=false",
      // Throwaway: development mode does not check tokens, and the API is bound to 127.0.0.1.
      "-e", `CUBEJS_API_SECRET=${randomUUID()}`,
      "-v", `${modelDir}:/cube/conf/model:ro`,
      CUBE_IMAGE,
    ]);
    const port = publishedPort(cubeContainer);
    const apiBase = `http://127.0.0.1:${port}/cubejs-api/v1`;
    await waitForCube(cubeContainer, apiBase);

    return {
      kind: "running",
      stack: {
        apiBase,
        network,
        pgContainer,
        cubeContainer,
        psql: (sqlText) => psql(pgContainer, sqlText),
        cubeLogs: (lines = 60) => tailLogs(cubeContainer, lines),
        stop,
      },
    };
  } catch (e) {
    const logs = `postgres:\n${tailLogs(pgContainer, 20)}\ncube:\n${tailLogs(cubeContainer, 60)}`;
    stop();
    throw new Error(`cube stack failed to start: ${e instanceof Error ? e.message : String(e)}\n${logs}`, { cause: e });
  }
}

/** Pull `image` unless it is already present, with the pull's own budget. */
async function ensureImage(image: string): Promise<void> {
  const present = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 60_000 });
  if (present.status === 0) return;
  const r = await run("docker", ["pull", "--quiet", image], PULL_TIMEOUT_MS);
  if (r.status !== 0) throw new Error(`docker pull ${image} failed (${r.status === null ? "timed out" : `exit ${r.status}`}): ${r.output}`);
}

/**
 * The postgres entrypoint runs a temporary server on the unix socket only, then restarts.
 * A TCP connection inside the container can only reach the final server.
 */
async function waitForPostgres(name: string): Promise<void> {
  const deadline = Date.now() + PG_READY_TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    assertRunning(name, "postgres");
    const r = spawnSync("docker", ["exec", name, "psql", "-h", "127.0.0.1", "-U", "postgres", "-qAt", "-c", "select 1"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (r.status === 0 && r.stdout.trim() === "1") return;
    await sleep(500);
  }
  throw new Error(`postgres container '${name}' did not accept a TCP connection within ${PG_READY_TIMEOUT_S}s`);
}

/** Until `/meta` answers with JSON: a model, or the model's compile error (the test reads which). */
async function waitForCube(name: string, apiBase: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_S * 1000;
  let last = "no answer yet";
  while (Date.now() < deadline) {
    assertRunning(name, "cube");
    try {
      const res = await fetch(`${apiBase}/meta`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const text = await res.text();
      try {
        JSON.parse(text);
        return;
      } catch {
        last = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      }
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(1000);
  }
  throw new Error(`cube container '${name}' did not answer ${apiBase}/meta within ${READY_TIMEOUT_S}s (last: ${last}); set MO_CUBE_READY_TIMEOUT_S to wait longer`);
}

/** A container that exited during startup is a failure now, not a timeout later. */
function assertRunning(name: string, what: string): void {
  const r = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", name], { encoding: "utf8", timeout: 30_000 });
  const state = r.status === 0 ? r.stdout.trim() : "gone";
  if (state !== "running") throw new Error(`${what} container '${name}' is '${state}', not running: it died during startup`);
}

/** The host port docker bound for the container's 4000/tcp, e.g. `127.0.0.1:49153` → 49153. */
function publishedPort(name: string): number {
  const out = docker(["port", name, "4000/tcp"]);
  const m = /:(\d+)\s*$/m.exec(out.split("\n")[0] ?? "");
  if (m === null) throw new Error(`docker port ${name} 4000/tcp printed no port: '${out}'`);
  return Number(m[1]);
}

function psql(name: string, sqlText: string): string {
  const r = spawnSync("docker", ["exec", "-i", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt"], {
    input: sqlText,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`psql in '${name}' failed (exit ${String(r.status)}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

function tailLogs(name: string, lines: number): string {
  const r = spawnSync("docker", ["logs", "--tail", String(lines), name], { encoding: "utf8", timeout: 30_000 });
  return r.status === 0 ? `${r.stdout}${r.stderr}`.trim() : "(docker logs unavailable)";
}

function docker(args: string[]): string {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${r.stderr || r.stdout || r.error?.message || ""}`);
  return r.stdout.trim();
}

/** A child process with a deadline that does not block the event loop (a pull can take minutes). */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (b: Buffer): void => {
      output = (output + b.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ status: 1, output: e.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ status: signal === null ? code : null, output: output.trim() });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}
