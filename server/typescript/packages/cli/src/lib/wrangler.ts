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
 * The reason to report when wrangler exits non-zero.
 *
 * **`--json` puts wrangler's error on STDOUT, and warnings on stderr.** This function
 * exists because the runner used to report stderr alone, so a live D1 gate failing for
 * want of a `CLOUDFLARE_API_TOKEN` told the adopter its cause was
 * `▲ [WARNING] … "unsafe" fields are experimental` — a warning, named as the reason a
 * schema gate failed, with the real cause discarded. Found by running an estate's own
 * `verify:prod-schema` against production for the first time.
 *
 * Order: the structured error wrangler wrote, then stderr, then raw stdout, then the
 * process's own message. Stderr is still consulted — a genuine wrangler failure that
 * never reaches stdout must not be swallowed to fix the opposite mistake.
 */
export function wranglerFailureReason(
  stdout: string,
  stderr: string,
  fallback: string,
): string {
  const structured = structuredWranglerError(stdout);
  if (structured !== undefined) return structured;
  const err = stderr.trim();
  if (err.length > 0) return err;
  const out = stdout.trim();
  if (out.length > 0) return out;
  return fallback;
}

/** wrangler's two `--json` error shapes: `{error:{text}}` / `{error}` and the
 *  `[{success:false,error}]` execute envelope. Anything else reads as absent. */
function structuredWranglerError(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const node = Array.isArray(parsed) ? parsed[0] : parsed;
  if (node === null || typeof node !== "object") return undefined;
  const { error } = node as { error?: unknown };
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  if (error !== null && typeof error === "object") {
    const { text } = error as { text?: unknown };
    if (typeof text === "string" && text.trim().length > 0) return text.trim();
  }
  return undefined;
}

/**
 * Run wrangler with the given args; return stdout. The failure REASON is chosen by
 * `wranglerFailureReason` when wrangler exits non-zero. `cwd` is the directory wrangler
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
    const reason = wranglerFailureReason(e.stdout ?? "", e.stderr ?? "", e.message);
    throw new Error(`wrangler ${args.join(" ")} failed: ${reason}`);
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
