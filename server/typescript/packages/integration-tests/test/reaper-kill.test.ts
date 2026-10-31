/**
 * A killed run removes its containers.
 *
 * Public behaviour: once a process that started a test container dies without running any
 * teardown, Docker stops listing that container. The oracle is Docker itself, queried from
 * outside the killed process. A helper that labels nothing, or a reaper that accepts the label
 * and removes nothing, fails on the deadline. Sharing a Ryuk session between processes fails the
 * first test, because the killed process's container then outlives it for as long as the other
 * process stays connected.
 */

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CHILD_SCRIPT = join(import.meta.dir, "reaper-child.ts");
const REPO_ROOT = resolve(import.meta.dir, "../../../../..");
const CI_LOCAL = join(REPO_ROOT, "scripts/ci-local.sh");
const CAN_RUN_CI_LOCAL = existsSync(CI_LOCAL) && spawnSync("bash", ["--version"]).status === 0;

const CHILD_READY_MS = 60_000;
const SIDECAR_START_MS = 120_000;
// Ryuk waits 10s, then Docker has to finish the container's exit, and it cannot until the overlay
// unmount has flushed the host filesystem's dirty pages. A busy disk makes removal slow, not wrong.
// Measured with a 256 MiB backlog: 34-38s at 12 MB/s and 67-76s at 6 MB/s, against under 11s at
// 6 MB/s with no backlog. Every removal succeeded.
const REMOVAL_BOUND_MS = 120_000;
const TEARDOWN_MARGIN_MS = 60_000;
const POLL_MS = 250;

function docker(...args: string[]): string {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${r.error?.message ?? r.stderr}`);
  return r.stdout.trim();
}

const exists = (name: string): boolean => docker("ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}") !== "";
const status = (name: string): string => docker("ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Status}}");
const isRunning = (name: string): boolean =>
  docker("ps", "--filter", `name=^${name}$`, "--filter", "status=running", "--format", "{{.Names}}") !== "";
const removeOwn = (name: string): void => { spawnSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore", timeout: 30_000 }); };

async function waitUntil(condition: () => boolean, boundMs: number): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  return condition();
}

async function expectRemoved(name: string): Promise<void> {
  const removed = await waitUntil(() => !exists(name), REMOVAL_BOUND_MS);
  if (!removed) throw new Error(`container ${name} still exists ${REMOVAL_BOUND_MS / 1000}s after its process ended (${status(name)})`);
}

interface Child {
  readonly process: ChildProcess;
  container?: string;
}

/** Starts a child, which uses its own Postgres container whatever this lane is pointed at. */
async function startChild(children: Child[]): Promise<Child & { container: string }> {
  const { METAOBJECTS_TEST_PG_URL: _lanePg, ...env } = process.env;
  const proc = spawn(process.execPath, ["run", CHILD_SCRIPT], { env, stdio: ["ignore", "pipe", "pipe"] });
  const child: Child = { process: proc };
  children.push(child);
  let output = "";
  proc.stdout?.on("data", (chunk) => { output += chunk; });
  proc.stderr?.on("data", (chunk) => { output += chunk; });

  const ready = await waitUntil(() => /^READY \d+$/m.test(output) || proc.exitCode !== null, CHILD_READY_MS);
  const port = /^READY (\d+)$/m.exec(output)?.[1];
  if (!ready || port === undefined) throw new Error(`reaper child never reported its container:\n${output}`);
  const container = docker("ps", "--filter", `publish=${port}/tcp`, "--format", "{{.Names}}");
  expect(container).not.toBe("");
  child.container = container;
  return { ...child, container };
}

describe("a killed run removes its containers", () => {
  test("one process's death removes its container and leaves another process's running", async () => {
    const children: Child[] = [];
    try {
      const killed = await startChild(children);
      const survivor = await startChild(children);

      killed.process.kill("SIGKILL");
      await expectRemoved(killed.container);
      expect(isRunning(survivor.container)).toBe(true);

      survivor.process.kill("SIGTERM");
      await expectRemoved(survivor.container);
    } finally {
      for (const child of children) {
        child.process.kill("SIGKILL");
        if (child.container !== undefined) removeOwn(child.container);
      }
    }
  }, 2 * CHILD_READY_MS + 2 * REMOVAL_BOUND_MS + TEARDOWN_MARGIN_MS);

  test.skipIf(!CAN_RUN_CI_LOCAL)("a killed ci-local run removes its Postgres sidecar", async () => {
    const sidecar = `metaobjects-test-sidecar-${randomUUID().slice(0, 8)}`;
    const scratch = mkdtempSync(join(tmpdir(), "mo-reaper-kill-"));
    const { METAOBJECTS_TEST_PG_URL: _lanePg, MO_CI_NO_PG_SIDECAR: _optOut, ...env } = process.env;
    const run = spawn("bash", [CI_LOCAL, "--integration-only", "--only", "python"], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: "ignore",
      env: { ...env, MO_PG_SIDECAR_NAME: sidecar, TMPDIR: scratch },
    });
    const killGroup = (): void => {
      try { if (run.pid !== undefined) process.kill(-run.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    try {
      const started = await waitUntil(() => exists(sidecar), SIDECAR_START_MS);
      if (!started) throw new Error(`ci-local never started sidecar ${sidecar}`);
      killGroup();
      await expectRemoved(sidecar);
    } finally {
      killGroup();
      removeOwn(sidecar);
      rmSync(scratch, { recursive: true, force: true });
    }
  }, SIDECAR_START_MS + REMOVAL_BOUND_MS + TEARDOWN_MARGIN_MS);
});
