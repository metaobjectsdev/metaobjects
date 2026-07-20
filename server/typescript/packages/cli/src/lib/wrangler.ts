import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface WranglerExecuteOptions {
  binding: string;
  remote: boolean;
  command: string;
  configPath: string | undefined;
}

export function buildWranglerExecuteArgs(opts: WranglerExecuteOptions): string[] {
  const args: string[] = [
    "d1", "execute", opts.binding,
    opts.remote ? "--remote" : "--local",
    "--json",
    "--command", opts.command,
  ];
  if (opts.configPath !== undefined) {
    args.push("--config", opts.configPath);
  }
  return args;
}

/**
 * Run wrangler with the given args; return stdout. Stderr is included in the
 * error message when wrangler exits non-zero. `cwd` is the directory wrangler
 * runs in (defaults to process.cwd() — caller should pass the project root).
 */
export type WranglerRunner = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

export const defaultWranglerRunner: WranglerRunner = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFile("wrangler", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === "ENOENT") {
      throw new Error(`wrangler not found on PATH; install it: 'npm i -D wrangler'`);
    }
    const stderr = e.stderr ?? "";
    throw new Error(`wrangler ${args.join(" ")} failed: ${stderr || e.message}`);
  }
};

/**
 * #225 footgun guard — true when a `file:`-scheme DB URL's path falls inside
 * wrangler's LOCAL D1 state directory (`.wrangler/state/**\/d1/**`, e.g.
 * `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite`).
 *
 * `meta verify --db` pointed at that file RUNS — it's an ordinary sqlite file —
 * and reports "schema in sync", but it verified the LOCAL shadow database, not
 * the deployed one. That is a false green on exactly the failure mode D1
 * adopters care about most (local↔remote divergence). Used only to WARN (see
 * the call site in `verify.ts`) — never to redirect: making the local file a
 * convenient default is exactly the confusion #225 rejected.
 */
export function isWranglerLocalD1StatePath(dbUrl: string): boolean {
  if (!dbUrl.startsWith("file:")) return false;
  const path = dbUrl.slice("file:".length).replace(/\\/g, "/");
  return /(^|\/)\.wrangler\/state\/.*\/d1(\/|$)/.test(path);
}
