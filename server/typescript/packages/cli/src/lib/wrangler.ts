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
 * Wrangler emits an array envelope: [{ results: [...], success: bool, meta: {...} }].
 * Returns the rows from the first result element. Throws if not parseable or success=false.
 */
export function parseWranglerExecuteJson(stdout: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`failed to parse wrangler JSON output: ${(err as Error).message}`);
  }
  const envelope = Array.isArray(parsed) ? parsed[0] : parsed;
  if (envelope === undefined || envelope === null || typeof envelope !== "object") {
    throw new Error(`unexpected wrangler output shape: ${stdout.slice(0, 200)}`);
  }
  const env = envelope as { success?: boolean; error?: string; results?: unknown };
  if (env.success === false) {
    throw new Error(`wrangler d1 execute failed: ${env.error ?? "(no error message)"}`);
  }
  const results = env.results;
  if (!Array.isArray(results)) return [];
  return results as Record<string, unknown>[];
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
