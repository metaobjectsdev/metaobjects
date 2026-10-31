// reaperLabelArgs — the `--label` flags that put a docker-CLI test container under Ryuk.
//
// A test's afterAll or stop() cannot run in a killed process: SIGKILL, the kernel OOM killer and
// earlyoom all skip it, so a run that dies leaves its containers behind. Ryuk, the Testcontainers
// reaper, closes that gap from outside the process. It runs in its own container and holds one
// TCP connection from each client. When the last connection closes, for any reason, it waits ten
// seconds and removes everything carrying the session labels it was given. The operating system
// closes the socket of a killed process, so no code in the dying process has to run.
//
// Only the label changes hands here. testcontainers-node's `GenericContainer.start()` is what
// hangs under Bun (see postgres-container.ts); `getReaper` works, and the helpers keep their
// docker-CLI path. Clients of one Ryuk share its session, so another live run keeps that session's
// containers alive until it ends too: reaping can wait, but never removes a container in use.
//
// `TESTCONTAINERS_RYUK_DISABLED=true` turns the reaper off, as it does everywhere else.

let labelArgs: Promise<readonly string[]> | undefined;

async function startReaper(): Promise<readonly string[]> {
  // Imported here because the sidecar path never starts a container and should not load dockerode.
  const { getContainerRuntimeClient, getReaper } = await import("testcontainers");
  const reaper = await getReaper(await getContainerRuntimeClient());
  return ["--label", `org.testcontainers.session-id=${reaper.sessionId}`];
}

/**
 * Flags for `docker run` and `docker network create`. The first call starts or joins Ryuk, and
 * must finish before the container starts, so a run killed at any later moment is covered.
 */
export function reaperLabelArgs(): Promise<readonly string[]> {
  labelArgs ??= startReaper();
  return labelArgs;
}
