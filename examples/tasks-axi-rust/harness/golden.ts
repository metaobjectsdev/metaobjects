// Record golden outputs from the REAL tasks-axi, so `cargo test` can check tasks-axi-rs against
// them with no node in sight.
//
//   bun harness/golden.ts            # rewrite crates/tasks-axi-rs/tests/golden/
//
// Format (crates/tasks-axi-rs/tests/golden/golden.txt): one record per case, tab-separated lines
//   case<TAB>name        arg<TAB>text        env<TAB>KEY<TAB>text
//   file<TAB>path<TAB>fixture     home<TAB>path<TAB>fixture
//   code<TAB>n           stdout<TAB>text     (end of record: a blank line)
// Text is escaped (\\ \n \r \t); a fixture is a file under fixtures/ holding the bytes to write.

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { backlogCases, fixedCases, type Case } from "./cases.js";
import { makeSandbox, run, scratchRoot, type FileMap } from "./sandbox.js";

const REAL = process.env.TASKS_AXI_BIN ?? "tasks-axi";
const OUT = resolve(import.meta.dirname, "..", "crates", "tasks-axi-rs", "tests", "golden");
const SEEDS = [1, 2, 3];
// Per backlog: the commands that between them reach every column set, hint and group.
const KEEP = /\/(list|list-queued|list-held|list-blocked|list-allfields|list-limit1|ready|ready-held|ready-repo|show-missing)$|\/show(-full)?-/;

const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");

function selected(): Case[] {
  const cases: Case[] = [...fixedCases()];
  for (const s of SEEDS) {
    const all = backlogCases(s).filter((c) => KEEP.test(c.name));
    const shows = all.filter((c) => c.args[0] === "show" || c.args[0] === "view").slice(0, 4);
    cases.push(...all.filter((c) => c.args[0] !== "show" && c.args[0] !== "view"), ...shows);
  }
  return cases;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "fixtures"), { recursive: true });
const written = new Set<string>();
const fixture = (content: string | Buffer): string => {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const name = createHash("sha256").update(buf).digest("hex").slice(0, 16) + ".bin";
  if (!written.has(name)) {
    writeFileSync(join(OUT, "fixtures", name), buf);
    written.add(name);
  }
  return name;
};
const tree = (kind: string, files: FileMap | undefined): string[] =>
  Object.entries(files ?? {}).map(([path, content]) => `${kind}\t${esc(path)}\t${fixture(content)}`);

const root = scratchRoot();
const records: string[] = [];
try {
  for (const c of selected()) {
    const sb = makeSandbox(root, c.name, c);
    const r = await run(REAL, c, sb);
    sb.dispose();
    if (r.stderr.length > 0) throw new Error(`${c.name}: the real tool wrote to stderr`);
    records.push(
      [
        `case\t${c.name}`,
        ...c.args.map((a) => `arg\t${esc(a)}`),
        ...Object.entries(c.env ?? {}).map(([k, v]) => `env\t${k}\t${esc(v)}`),
        ...tree("file", c.files),
        ...tree("home", c.home),
        `code\t${r.code}`,
        `stdout\t${esc(r.stdout.toString("utf8"))}`,
        "",
      ].join("\n"),
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
writeFileSync(join(OUT, "golden.txt"), records.join("\n") + "\n");
console.log(`golden: ${records.length} cases, ${written.size} fixtures`);
