// A test database lives in RAM and never outlives the run that started it.
//
// Storage. Each database image declares a VOLUME for its data directory. A container started
// without a mount there gets an anonymous volume on disk, which stays behind after the container
// is removed without `-v`. Every launcher therefore mounts a size-capped tmpfs at that path
// (ramVolume), and Postgres runs with durability off (POSTGRES_DURABILITY_OFF): nothing written
// to a throwaway database needs to survive a crash.
//
// Removal. stop() and afterAll run only when the test gets that far. Ryuk (test-reaper.ts)
// removes the containers of a killed process from outside it, ten seconds after it dies.
// removeOnExit covers the exits Ryuk does not see at once: a normal exit with a stop() that never
// ran, and Ctrl-C or SIGTERM, after which the process exits as the signal would have.

import { spawnSync } from "node:child_process";

/** Upper bound for one database's data directory. A tmpfs takes RAM only for what is written. */
export const TMPFS_SIZE = "2g";

/** The data directory `mysql:8*` declares as its VOLUME (`docker image inspect`). */
export const MYSQL_8_DATA_DIR = "/var/lib/mysql";

/**
 * The data directory a Postgres image declares as its VOLUME: `/var/lib/postgresql` from
 * Postgres 18, `/var/lib/postgresql/data` before it (`docker image inspect`). The major comes
 * from a `postgres:<major>` tag or a `pg<major>` tag (pgvector). A tag that names no major
 * (`latest`, none, a digest) is today's release, 18 or later, so it takes the newer path:
 * guessing the older one there would leave the data on an anonymous on-disk volume.
 */
export function postgresDataDir(image: string): string {
  const tag = /:([^/:@]+)(?:@.*)?$/.exec(image)?.[1] ?? "";
  const major = /^(\d+)/.exec(tag)?.[1] ?? /(?:^|-)pg(\d+)/.exec(tag)?.[1];
  return major === undefined || Number(major) >= 18 ? "/var/lib/postgresql" : "/var/lib/postgresql/data";
}

/** `postgres` server options for a database whose contents may be lost at any moment. */
export const POSTGRES_DURABILITY_OFF: readonly string[] = [
  "-c", "fsync=off",
  "-c", "synchronous_commit=off",
  "-c", "full_page_writes=off",
];

/** `docker run` flags mounting a size-capped tmpfs at `path`, the image's VOLUME. */
export function ramVolume(path: string): string[] {
  return ["--tmpfs", `${path}:rw,size=${TMPFS_SIZE}`];
}

const started = new Set<string>();
let hooksInstalled = false;

function removeAll(): void {
  if (started.size > 0) {
    spawnSync("docker", ["rm", "-f", "-v", ...started], { stdio: "ignore", timeout: 60_000 });
  }
  started.clear();
}

function onSignal(signal: NodeJS.Signals): void {
  removeAll();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

/**
 * Remove container `name` when this process exits or is interrupted. Returns the function the
 * launcher calls once it removed the container itself, so exit has nothing left to do for it.
 */
export function removeOnExit(name: string): () => void {
  started.add(name);
  if (!hooksInstalled) {
    hooksInstalled = true;
    process.on("exit", removeAll);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }
  return () => { started.delete(name); };
}
