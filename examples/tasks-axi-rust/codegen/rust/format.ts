import { spawnSync } from "node:child_process";

/** Run `rustfmt` over Rust text (stdin to stdout). The committed goldens are rustfmt output, so
 *  the generator's own emit may be sloppy about layout; only this step decides it. */
export function rustfmt(source: string): string {
  const r = spawnSync("rustfmt", ["--edition", "2021", "--emit", "stdout"], { input: source, encoding: "utf8" });
  if (r.error) throw new Error(`rust-cli: cannot run rustfmt: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`rust-cli: rustfmt rejected the emitted Rust:\n${r.stderr}\n--- source ---\n${source}`);
  // `--emit stdout` prefixes a "<path>:" line only when given files; stdin gets bare output.
  return r.stdout;
}
