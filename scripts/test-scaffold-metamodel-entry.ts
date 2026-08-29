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
  // A throwaway MANIFEST too, or the tree is not a throwaway: with the real one in
  // scope every case passes or fails on repository state no assertion names.
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ types: [{ type: "field", subType: "string" }] }));
  const args = [SCAFFOLD];
  if (opts.apply === true) args.push("--apply");
  args.push(join(dir, "metaobjects"), join(dir, "spec"), join(dir, "manifest.json"));
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

// A proposal is DRIFT, so the bare run must FAIL — ci-local.sh runs it as a gate
// whose whole claim is that nothing needs scaffolding.
const dry = run("fieldSomethingNew");
expect(
  "a requirement for unregistered vocabulary FAILS the bare run",
  dry.status !== 0 && dry.output.includes("would write") && dry.output.includes("field.somethingNew"),
  dry.output,
);
expect(
  "the proposal names the authored TITLE, not the node name",
  dry.output.includes("A new thing"),
  dry.output,
);
const dryWrote = readFileSync(dry.specFile, "utf8");
expect("a dry run writes nothing", !dryWrote.includes("somethingNew"), dryWrote);
rmSync(dry.dir, { recursive: true, force: true });

const applied = run("fieldSomethingNew", { apply: true });
const written = readFileSync(applied.specFile, "utf8");
expect(
  "--apply exits 0 once the stub is written",
  applied.status === 0,
  applied.output,
);
expect(
  "--apply writes the stub into the right provider file",
  written.includes('"subType": "somethingNew"'),
  written,
);
expect(
  "the stub REFUSES to invent prose — description, whenToUse and rules stay placeholders",
  (written.match(/TODO — write this by hand/g) ?? []).length === 3
    && !written.includes("A promise about something that does not exist yet"),
  written,
);
rmSync(applied.dir, { recursive: true, force: true });

// A levelled requirement.architectural at L4 is VALID metadata (0.23.0) and names no
// subtype — object-independence is what architectural MEANS. Every one of these
// scripts convicted it before the filter went in.
const archDir = mkdtempSync(join(tmpdir(), "mo-scaffold-arch-"));
mkdirSync(join(archDir, "metaobjects"), { recursive: true });
mkdirSync(join(archDir, "spec"), { recursive: true });
writeFileSync(join(archDir, "spec", "field.json"), JSON.stringify({ provider: "test", types: [] }, null, 2));
writeFileSync(join(archDir, "manifest.json"), JSON.stringify({ types: [{ type: "field", subType: "string" }] }));
writeFileSync(join(archDir, "metaobjects", "meta.requirements.yaml"), `
metadata.root:
  package: metaobjects
  children:
    - requirement.architectural:
        name: quality
        level: 3
        status: live
        statement: "Everything holds."
        counterexample: "Something does not."
        children:
          - requirement.architectural:
              name: inputValidation
              level: 4
              status: live
              statement: "Every input is validated."
              counterexample: "One input is not."
`);
const arch = spawnSync("bun", [SCAFFOLD, join(archDir, "metaobjects"), join(archDir, "spec"), join(archDir, "manifest.json")], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
expect(
  "a levelled architectural L4 is ignored, not convicted",
  (arch.status ?? 1) === 0 && `${arch.stdout}`.includes("nothing to scaffold"),
  `${arch.stdout}${arch.stderr}`,
);
rmSync(archDir, { recursive: true, force: true });

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
