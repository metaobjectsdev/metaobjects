// Run one invocation of a binary in a throwaway sandbox (a cwd and a HOME under $DEV_SCRATCH,
// RAM-backed), capturing stdout, stderr and the exit code byte-for-byte.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type FileMap = Record<string, string | Buffer>;

export interface Invocation {
  args: string[];
  /** Files written under the working directory. */
  files?: FileMap;
  /** Files written under HOME. */
  home?: FileMap;
  /** Extra environment (TASKS_AXI_FILE, ...). HOME, TZ and PATH are always set. */
  env?: Record<string, string>;
}

export interface Result {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
}

export function scratchRoot(): string {
  const base = process.env.DEV_SCRATCH && process.env.DEV_SCRATCH !== "" ? process.env.DEV_SCRATCH : tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "tasks-axi-harness-"));
}

function writeTree(root: string, files: FileMap | undefined): void {
  for (const [rel, content] of Object.entries(files ?? {})) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export interface Sandbox {
  cwd: string;
  home: string;
  dispose(): void;
}

export function makeSandbox(root: string, name: string, inv: Invocation): Sandbox {
  const dir = mkdtempSync(join(root, `${name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40)}-`));
  const cwd = join(dir, "cwd");
  const home = join(dir, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeTree(cwd, inv.files);
  writeTree(home, inv.home);
  return { cwd, home, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

export function run(bin: string, inv: Invocation, sb: Sandbox, timeoutMs = 30_000): Promise<Result> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sb.home,
      TZ: "UTC",
      LANG: "C.UTF-8",
      ...(inv.env ?? {}),
    };
    const child = spawn(bin, inv.args, { cwd: sb.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code });
    });
  });
}

/** Run `work` over `items` with at most `n` in flight. */
export async function pool<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await work(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: n }, lane));
}
