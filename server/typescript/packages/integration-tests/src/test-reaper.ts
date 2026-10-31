// reaperLabelArgs — the `--label` flags that put a docker-CLI test container under Ryuk.
//
// A test's afterAll or stop() cannot run in a killed process: SIGKILL, the kernel OOM killer and
// earlyoom all skip it, so a run that dies leaves its containers behind. Ryuk, the Testcontainers
// reaper, closes that gap from outside the process. It runs in its own container and holds one
// TCP connection from each client. When the last connection closes, for any reason, it waits ten
// seconds and removes everything carrying the session labels it was given. The operating system
// closes the socket of a killed process, so no code in the dying process has to run.
//
// Each process starts a private Ryuk here, so a killed process's containers go when that process
// goes, whatever else is running on the host. testcontainers-node's `getReaper` cannot give that:
// it adopts any Ryuk already running on the host, a sibling project's included, and that Ryuk's
// session with it, so the containers would wait for every other client of that Ryuk to end. Its
// TESTCONTAINERS_RYUK_TEST_LABEL hides only Ryuks that carry the same label, so it does not help.
//
// The connection is unreferenced: it lives as long as the process and never delays its exit. A
// Ryuk that no client reaches stops by itself after a minute, and `--rm` removes it.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { publishedPort } from "./postgres-container.ts";

const RYUK_IMAGE = "testcontainers/ryuk:0.14.0";
const SESSION_LABEL = "org.testcontainers.session-id";
/** Long enough to pull the image once. */
const DOCKER_RUN_TIMEOUT_MS = 180_000;
const REGISTER_DEADLINE_MS = 15_000;
const REGISTER_ATTEMPT_TIMEOUT_MS = 5_000;
const REGISTER_RETRY_DELAY_MS = 200;

let labelArgs: Promise<readonly string[]> | undefined;
/** Held here for the life of the process: losing this connection ends the session. */
let ryukConnection: Socket | undefined;

/** One registration attempt. Docker publishes the port before Ryuk listens, so a refused or
 *  reset connection only means "not yet"; it resolves undefined rather than rejecting. */
function register(port: number, label: string): Promise<Socket | undefined> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let reply = "";
    const giveUp = (): void => {
      socket.destroy();
      resolve(undefined);
    };
    socket.setTimeout(REGISTER_ATTEMPT_TIMEOUT_MS, giveUp);
    socket.on("error", giveUp);
    socket.on("close", giveUp);
    socket.on("connect", () => socket.write(`label=${label}\n`));
    socket.on("data", (chunk) => {
      reply += chunk.toString();
      if (reply !== "ACK\n") return;
      socket.setTimeout(0);
      socket.unref();
      resolve(socket);
    });
  });
}

async function startReaper(): Promise<readonly string[]> {
  const sessionId = randomUUID();
  const name = `metaobjects-test-ryuk-${sessionId.slice(0, 8)}`;
  const label = `${SESSION_LABEL}=${sessionId}`;
  const run = spawnSync("docker", [
    "run", "-d", "--rm", "--name", name,
    "-v", "/var/run/docker.sock:/var/run/docker.sock",
    "-p", "127.0.0.1::8080",
    RYUK_IMAGE,
  ], { encoding: "utf8", timeout: DOCKER_RUN_TIMEOUT_MS });

  let failure = `docker run failed: ${run.error?.message ?? run.stderr}`;
  if (run.status === 0) {
    try {
      const port = publishedPort(name, 8080);
      failure = `no ACK within ${REGISTER_DEADLINE_MS / 1000}s`;
      const deadline = Date.now() + REGISTER_DEADLINE_MS;
      while (Date.now() < deadline) {
        ryukConnection = await register(port, label);
        if (ryukConnection !== undefined) return ["--label", label];
        await new Promise((res) => setTimeout(res, REGISTER_RETRY_DELAY_MS));
      }
    } catch (e) {
      failure = String(e);
    }
  }
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 30_000 });
  throw new Error(`could not start Ryuk (${RYUK_IMAGE}): ${failure}`);
}

/**
 * Flags for `docker run` and `docker network create`. The first call starts this process's Ryuk,
 * and must finish before the container starts, so a run killed at any later moment is covered.
 */
export function reaperLabelArgs(): Promise<readonly string[]> {
  labelArgs ??= startReaper();
  return labelArgs;
}
