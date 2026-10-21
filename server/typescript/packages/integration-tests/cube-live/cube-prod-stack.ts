// cube-prod-stack.ts — Cube's PRODUCTION mode for the live lane: `CUBEJS_DEV_MODE=false`, a signed
// JWT on every request, and a real Cube Store container that holds the rollups.
//
// It adds to a stack src/cube-container.ts already started (the private network, the seeded
// database, the model directory) rather than replacing it: startCubeStack owns the network and the
// database, and `stop()` here removes the two containers it adds before handing the rest to the
// base stack's own `stop()`. Everything stays on the private network; the one published port is
// the API's, ephemeral and bound to 127.0.0.1.

import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { CUBE_IMAGE, type CubeDataSource, type CubeStack } from "../src/cube-container.ts";
import type { CubeEndpoint } from "./cube-live-support.ts";

/** Cube Store, pinned to the release of the Cube image (a rollup is written and read through it). */
export const CUBE_STORE_IMAGE = "cubejs/cubestore:v1.7.43";

/** The credentials src/cube-container.ts gives the throwaway database it starts. */
const DB_PASSWORD = "test";
const MYSQL_DATABASE = "mo_test";

const READY_TIMEOUT_S = 300;
const PULL_TIMEOUT_MS = 15 * 60_000;

export interface ProdCube extends CubeEndpoint {
  readonly headers: Readonly<Record<string, string>>;
  readonly storeContainer: string;
  readonly cubeContainer: string;
  /** Remove Cube, Cube Store and then the base stack. Idempotent. */
  stop(): void;
}

/** An HS256 JWT over an empty security context, valid for a day: what production mode requires. */
function signJwt(secret: string): string {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iat: now, exp: now + 86_400 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

function docker(args: string[]): string {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${r.stderr || r.stdout || r.error?.message || ""}`);
  return r.stdout.trim();
}

function tail(name: string, lines: number): string {
  const r = spawnSync("docker", ["logs", "--tail", String(lines), name], { encoding: "utf8", timeout: 30_000 });
  return r.status === 0 ? `${r.stdout}${r.stderr}`.trim() : "(docker logs unavailable)";
}

function ensureImage(image: string): void {
  if (spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 60_000 }).status === 0) return;
  const r = spawnSync("docker", ["pull", "--quiet", image], { encoding: "utf8", timeout: PULL_TIMEOUT_MS });
  if (r.status !== 0) throw new Error(`docker pull ${image} failed: ${r.stderr || r.stdout}`);
}

/**
 * Start Cube Store and a production-mode Cube on `base`'s network, reading `base`'s database and the
 * model in `modelDir`. The base stack's development-mode Cube is removed first: it has no further
 * use, and only one Cube should read the model.
 */
export async function startProductionCube(base: CubeStack, modelDir: string, dataSource: CubeDataSource): Promise<ProdCube> {
  ensureImage(CUBE_STORE_IMAGE);
  spawnSync("docker", ["rm", "-f", "-v", base.cubeContainer], { stdio: "ignore", timeout: 120_000 });

  const storeContainer = `${base.network}-store`;
  const cubeContainer = `${base.network}-prodcube`;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    process.off("exit", stop);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    for (const name of [cubeContainer, storeContainer]) spawnSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore", timeout: 120_000 });
    base.stop();
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    stop();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  // Ahead of the base stack's own handlers: its network cannot be removed while ours are attached.
  process.prependListener("exit", stop);
  process.prependListener("SIGINT", onSignal);
  process.prependListener("SIGTERM", onSignal);

  try {
    docker(["run", "-d", "--name", storeContainer, "--network", base.network, CUBE_STORE_IMAGE]);
    const secret = randomUUID();
    const dbEnv =
      dataSource === "mysql"
        ? ["CUBEJS_DB_TYPE=mysql", `CUBEJS_DB_HOST=${base.pgContainer}`, "CUBEJS_DB_PORT=3306",
           `CUBEJS_DB_NAME=${MYSQL_DATABASE}`, "CUBEJS_DB_USER=root", `CUBEJS_DB_PASS=${DB_PASSWORD}`]
        : ["CUBEJS_DB_TYPE=postgres", `CUBEJS_DB_HOST=${base.pgContainer}`, "CUBEJS_DB_PORT=5432",
           "CUBEJS_DB_NAME=postgres", "CUBEJS_DB_USER=postgres", `CUBEJS_DB_PASS=${DB_PASSWORD}`];
    const env = [
      ...dbEnv,
      "CUBEJS_DEV_MODE=false",
      "NODE_ENV=production",
      "CUBEJS_TELEMETRY=false",
      `CUBEJS_API_SECRET=${secret}`,
      `CUBEJS_CUBESTORE_HOST=${storeContainer}`,
      "CUBEJS_CUBESTORE_PORT=3030",
      // The refresh worker runs in this process too; the lane also builds explicitly through the
      // jobs API (buildAllPreAggregations) and waits for every job, so nothing races a timer.
      "CUBEJS_REFRESH_WORKER=true",
      // The jobs API is off by default (`API scope is missing: jobs`).
      "CUBEJS_DEFAULT_API_SCOPES=meta,data,jobs",
    ];
    docker([
      "run", "-d", "--name", cubeContainer, "--network", base.network,
      "-p", "127.0.0.1::4000",
      ...env.flatMap((e) => ["-e", e]),
      "-v", `${modelDir}:/cube/conf/model:ro`,
      CUBE_IMAGE,
    ]);
    const out = docker(["port", cubeContainer, "4000/tcp"]);
    const m = /:(\d+)\s*$/m.exec(out.split("\n")[0] ?? "");
    if (m === null) throw new Error(`docker port ${cubeContainer} 4000/tcp printed no port: '${out}'`);
    const apiBase = `http://127.0.0.1:${Number(m[1])}/cubejs-api/v1`;
    const headers = { Authorization: signJwt(secret) };
    const cubeLogs = (lines = 60): string => `cube:\n${tail(cubeContainer, lines)}\ncube store:\n${tail(storeContainer, Math.min(lines, 30))}`;

    // Ready when /meta answers 200 with the token: production mode answers 403 without one.
    const deadline = Date.now() + READY_TIMEOUT_S * 1000;
    let last = "no answer yet";
    for (;;) {
      if (Date.now() > deadline) throw new Error(`production Cube did not answer ${apiBase}/meta within ${READY_TIMEOUT_S}s (last: ${last})`);
      const state = spawnSync("docker", ["inspect", "-f", "{{.State.Status}}", cubeContainer], { encoding: "utf8", timeout: 30_000 }).stdout.trim();
      if (state !== "running") throw new Error(`production Cube container is '${state}', not running`);
      try {
        const res = await fetch(`${apiBase}/meta`, { headers, signal: AbortSignal.timeout(10_000) });
        const text = await res.text();
        if (res.status === 200) {
          JSON.parse(text);
          break;
        }
        last = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      await Bun.sleep(1000);
    }
    return { apiBase, headers, storeContainer, cubeContainer, cubeLogs, stop };
  } catch (e) {
    const logs = `cube:\n${tail(cubeContainer, 60)}\ncube store:\n${tail(storeContainer, 30)}`;
    stop();
    throw new Error(`production Cube failed to start: ${e instanceof Error ? e.message : String(e)}\n${logs}`, { cause: e });
  }
}
