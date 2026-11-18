// Differential harness: run the real tasks-axi and tasks-axi-rs over the same synthetic
// backlogs and invocations and require byte-identical stdout, the same exit code and empty
// stderr from both. Then check that everything tasks-axi-rs does not implement is refused.
//
//   bun harness/differential.ts [--seeds N] [--start S] [--jobs J] [--only SUBSTRING] [--keep]
//
// Environment: TASKS_AXI_BIN (default `tasks-axi`), TASKS_AXI_RS_BIN (default: the debug binary
// under $CARGO_TARGET_DIR or ./target).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { backlogCases, fixedCases, refusalCases, type Case } from "./cases.js";
import { makeSandbox, pool, run, scratchRoot } from "./sandbox.js";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const SEEDS = Number(opt("seeds", "40"));
const START = Number(opt("start", "1"));
const JOBS = Number(opt("jobs", "4"));
const ONLY = opt("only", "");
const KEEP_FAILURES = opt("report-dir", "");

const REAL = process.env.TASKS_AXI_BIN ?? "tasks-axi";
const target = process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname, "..", "target");
const RUST = process.env.TASKS_AXI_RS_BIN ?? join(target, "debug", "tasks-axi-rs");
if (!existsSync(RUST)) {
  console.error(`tasks-axi-rs binary not found at ${RUST}; build it (cargo build -p tasks-axi-rs) or set TASKS_AXI_RS_BIN`);
  process.exit(2);
}

const show = (b: Buffer): string => JSON.stringify(b.toString("utf8"));

interface Failure {
  name: string;
  why: string;
}
const failures: Failure[] = [];
let compared = 0;
let refused = 0;

async function differential(c: Case, root: string): Promise<void> {
  const sb = makeSandbox(root, c.name, c);
  try {
    const [real, rs] = await Promise.all([run(REAL, c, sb), run(RUST, c, sb)]);
    compared++;
    const why: string[] = [];
    if (!real.stdout.equals(rs.stdout)) why.push(`stdout differs\n    real: ${show(real.stdout)}\n    rust: ${show(rs.stdout)}`);
    if (real.code !== rs.code) why.push(`exit code real=${real.code} rust=${rs.code}`);
    if (real.stderr.length > 0 || rs.stderr.length > 0) why.push(`stderr real=${show(real.stderr)} rust=${show(rs.stderr)}`);
    if (why.length > 0) {
      failures.push({ name: `${c.name}  [${c.args.join(" ")}]`, why: why.join("\n  ") });
      if (KEEP_FAILURES) {
        mkdirSync(KEEP_FAILURES, { recursive: true });
        writeFileSync(join(KEEP_FAILURES, `${c.name.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), JSON.stringify({ args: c.args, files: Object.keys(c.files ?? {}) }));
      }
    }
  } finally {
    sb.dispose();
  }
}

async function refusal(c: Case, root: string): Promise<void> {
  const sb = makeSandbox(root, c.name, c);
  try {
    const rs = await run(RUST, c, sb);
    refused++;
    const out = rs.stdout.toString("utf8");
    const problems: string[] = [];
    if (rs.code === 0) problems.push("exited 0");
    if (rs.stderr.length > 0) problems.push(`wrote to stderr: ${show(rs.stderr)}`);
    if (!/^error: .*\ncode: UNSUPPORTED\nhelp/.test(out)) problems.push(`not a clear UNSUPPORTED refusal: ${show(rs.stdout)}`);
    if (problems.length > 0) failures.push({ name: `${c.name}  [${c.args.join(" ")}]`, why: problems.join("; ") });
  } finally {
    sb.dispose();
  }
}

const root = scratchRoot();
const started = Date.now();
try {
  const all: Case[] = [...fixedCases()];
  for (let s = START; s < START + SEEDS; s++) all.push(...backlogCases(s));
  const diffCases = all.filter((c) => c.name.includes(ONLY));
  const refCases = refusalCases().filter((c) => c.name.includes(ONLY));
  await pool(diffCases, JOBS, (c) => differential(c, root));
  await pool(refCases, JOBS, (c) => refusal(c, root));
} finally {
  const { rmSync } = await import("node:fs");
  rmSync(root, { recursive: true, force: true });
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
for (const f of failures.slice(0, 25)) console.error(`FAIL ${f.name}\n  ${f.why}`);
if (failures.length > 25) console.error(`... and ${failures.length - 25} more`);
console.log(`differential: ${compared} compared, ${refused} refusals checked, ${failures.length} failed (${secs}s)`);
process.exit(failures.length === 0 ? 0 : 1);
