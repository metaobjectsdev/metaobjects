#!/usr/bin/env bun
// Self-test for scripts/scaffold-metamodel-entry.ts.
//
// A scaffolder nobody has watched scaffold is a scaffolder nobody knows works —
// and this one is only useful in a state the repository is never in, because the
// ledger currently covers every registered subtype. So the state is manufactured:
// a throwaway ledger promising vocabulary that exists nowhere, against a throwaway
// provider tree.
//
// The case that matters most is the LAST one. The scaffold's whole discipline is
// that it refuses to invent prose, so the test asserts the placeholders are there —
// a version that helpfully copied the requirement's statement into `description`
// would pass every other assertion here.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCAFFOLD = join(process.cwd(), "scripts/scaffold-metamodel-entry.ts");

interface Run { status: number; output: string; specFile: string; dir: string }

function run(subtypeName: string, opts: { apply?: boolean; withFieldProvider?: boolean } = {}): Run {
  const dir = mkdtempSync(join(tmpdir(), "mo-scaffold-"));
  mkdirSync(join(dir, "metaobjects"), { recursive: true });
  mkdirSync(join(dir, "spec"), { recursive: true });
  writeFileSync(join(dir, "metaobjects", "meta.requirements.yaml"), `
metadata.root:
  package: metaobjects
  children:
    - requirement.functional:
        name: declare
        level: 3
        status: live
        statement: "Things are declared."
        counterexample: "Nothing is declared."
        children:
          - requirement.functional:
              name: ${subtypeName}
              title: A new thing
              level: 4
              status: planned
              statement: "A promise about something that does not exist yet."
              counterexample: "The promise is broken."
`);
  if (opts.withFieldProvider !== false) {
    writeFileSync(join(dir, "spec", "field.json"), JSON.stringify({ provider: "test", types: [] }, null, 2));
  }
  const args = [SCAFFOLD];
  if (opts.apply === true) args.push("--apply");
  args.push(join(dir, "metaobjects"), join(dir, "spec"));
  const r = spawnSync("bun", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    status: r.status ?? 1,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    specFile: join(dir, "spec", "field.json"),
    dir,
  };
}

let failures = 0;
function expect(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}\n${detail}`); failures++; }
}

console.log("test-scaffold-metamodel-entry:");

const real = spawnSync("bun", [SCAFFOLD], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
expect(
  "the real ledger scaffolds nothing",
  (real.status ?? 1) === 0 && real.stdout.includes("nothing to scaffold"),
  `${real.stdout}${real.stderr}`,
);

const dry = run("fieldSomethingNew");
expect(
  "a requirement for unregistered vocabulary is a dry-run proposal",
  dry.status === 0 && dry.output.includes("would write") && dry.output.includes("field.somethingNew"),
  dry.output,
);
rmSync(dry.dir, { recursive: true, force: true });

const dryWrote = readFileSync(run("fieldSomethingNew").specFile, "utf8");
expect(
  "a dry run writes nothing",
  !dryWrote.includes("somethingNew"),
  dryWrote,
);

const applied = run("fieldSomethingNew", { apply: true });
const written = readFileSync(applied.specFile, "utf8");
expect(
  "--apply writes the stub into the right provider file",
  applied.status === 0 && written.includes('"subType": "somethingNew"'),
  written,
);
expect(
  "the stub REFUSES to invent prose — description, whenToUse and rules stay placeholders",
  (written.match(/TODO — write this by hand/g) ?? []).length === 3
    && !written.includes("A promise about something that does not exist yet"),
  written,
);
rmSync(applied.dir, { recursive: true, force: true });

const noProvider = run("fieldSomethingNew", { apply: true, withFieldProvider: false });
expect(
  "a type with no provider file is refused, not invented",
  noProvider.status !== 0 && noProvider.output.includes("bigger decision than a new subtype"),
  noProvider.output,
);
rmSync(noProvider.dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`test-scaffold-metamodel-entry: ${failures} failure(s)`);
  process.exit(1);
}
console.log("test-scaffold-metamodel-entry: all passed");
