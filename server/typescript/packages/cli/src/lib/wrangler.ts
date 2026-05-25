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
