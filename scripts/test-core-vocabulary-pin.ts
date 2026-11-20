#!/usr/bin/env bun
// Self-test for scripts/check-core-vocabulary-pin.ts.
//
// The gate is only worth having if adding vocabulary to core actually fails it, with a
// message that sends the author to GOVERNANCE.md and the pack mechanism, and if adding
// the same vocabulary to a pack does NOT. Each is driven against a throwaway copy of
// spec/metamodel, and every failing case asserts on the message, not just the exit code.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRegistry } from "../server/typescript/packages/metadata/src/provider.js";
import { coreTypesProvider } from "../server/typescript/packages/metadata/src/core-types.js";
import { computeCorePin } from "./check-core-vocabulary-pin.js";

const ROOT = process.cwd();
const CHECK = join(ROOT, "scripts/check-core-vocabulary-pin.ts");
const SPEC = join(ROOT, "spec/metamodel");
const PIN = join(ROOT, "fixtures/registry-conformance/core-vocabulary.pin.json");

let failures = 0;
const ok = (cond: boolean, what: string): void => {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${what}`);
  } else console.log(`ok: ${what}`);
};

function run(specDir: string): { status: number; output: string } {
  const r = spawnSync("bun", [CHECK, "--spec", specDir, "--pin", PIN], { encoding: "utf8" });
  return { status: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
}

function withSpecCopy(edit: (dir: string) => void): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "mo-core-pin-"));
  try {
    cpSync(SPEC, dir, { recursive: true });
    edit(dir);
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function editJson(dir: string, file: string, fn: (d: { types?: { children?: unknown[] }[]; extends?: unknown[] }) => void): void {
  const p = join(dir, file);
  const d = JSON.parse(readFileSync(p, "utf8"));
  fn(d);
  writeFileSync(p, JSON.stringify(d, null, 2));
}

const newAttr = { type: "attr", subType: "string", name: "shinyNewThing", min: 0, max: 1, description: "x" };

// 1. The committed pin matches the spec as it stands.
ok(run(SPEC).status === 0, "the committed pin matches spec/metamodel");

// 2. A new attribute on a core type fails, naming it and pointing at the pack mechanism.
{
  const r = withSpecCopy((d) => editJson(d, "field.json", (j) => j.types![0]!.children!.push(newAttr)));
  ok(r.status !== 0, "adding an attribute to a core type fails the gate");
  ok(r.output.includes("@shinyNewThing"), "  the failure names the added attribute");
  ok(r.output.includes("GOVERNANCE.md") && r.output.includes("pack"), "  the failure points at GOVERNANCE.md and the pack mechanism");
}

// 3. A new type under the core provider fails.
{
  const r = withSpecCopy((d) =>
    editJson(d, "index.json", (j) => j.types!.push({ type: "gizmo", subType: "base", description: "x", children: [] } as never)),
  );
  ok(r.status !== 0 && r.output.includes("gizmo.base"), "adding a type to the core provider fails, naming it");
}

// 4. The same vocabulary under a pack's provider id is fine: that is the point.
{
  const r = withSpecCopy((d) => {
    editJson(d, "view-expressions.json", (j) => j.types!.push({ type: "gizmo", subType: "base", description: "x", children: [] } as never));
  });
  ok(r.status === 0, "the same type added to a pack (not core) does not fail");
}

// 5. The TypeScript registry has no type outside the pin (catches vocabulary registered in code).
{
  const pin = computeCorePin(SPEC);
  const known = new Set([...Object.keys(pin.types), ...pin.registeredInCode]);
  const registry = composeRegistry([coreTypesProvider]);
  const stray = registry.allTypes().map((t) => `${t.type}.${t.subType}`).filter((k) => !known.has(k));
  ok(stray.length === 0, `the core-only TypeScript registry holds no unpinned type${stray.length ? `: ${stray.join(", ")}` : ""}`);
}

process.exit(failures === 0 ? 0 : 1);
