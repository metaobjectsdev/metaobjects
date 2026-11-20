#!/usr/bin/env bun
/**
 * Gate — the CORE provider's vocabulary is pinned.
 *
 * `metaobjects-core-types` is the one provider a project cannot leave out, so
 * everything in it is vocabulary every adopter, in every port, carries. GOVERNANCE.md
 * ("Extension packs and the core metamodel") says new vocabulary enters core only when a
 * second, independent consumer needs it; until then it lives in a PACK: a separate
 * provider, composed by default if it ships with the library, that a project can leave
 * out, move or version on its own (business rules, view expressions, reporting and the
 * requirements ledger are the worked examples; see docs/features/extending-with-providers.md).
 *
 * The pin makes that a mechanical failure instead of a code-review hope: adding a type,
 * a subtype or an attribute under the `metaobjects-core-types` provider, or a structural
 * child rule it admits, changes this file's computed view and the gate fails until
 * `fixtures/registry-conformance/core-vocabulary.pin.json` is regenerated, which is a
 * reviewed, core-maintainer decision (the diff shows exactly what entered core).
 *
 * The pin is derived from `spec/metamodel/*.json` (provider === "metaobjects-core-types"),
 * the cross-port source of truth, so it holds for every port at once: each port embeds a
 * byte-identical copy of those files, and the registry-conformance gate holds each port's
 * registry to the committed manifest. The TypeScript registry is checked too, because
 * `metadata.root` is registered in code and has no spec file.
 *
 * Usage: bun scripts/check-core-vocabulary-pin.ts [--update] [--spec <dir>] [--pin <file>]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CORE_PROVIDER_ID = "metaobjects-core-types";

interface ChildDefLike {
  type: string;
  subType?: string | readonly string[];
  name: string;
  min?: number;
  max?: number | null;
}
interface TypeDefLike {
  type: string;
  subType: string;
  children?: ChildDefLike[];
}
interface ExtendDefLike {
  type: string;
  subType: string | readonly string[];
  children: ChildDefLike[];
}
interface DefinitionLike {
  provider: string;
  types?: TypeDefLike[];
  extends?: ExtendDefLike[];
}

export interface CorePin {
  /** "type.subType" -> its own attribute names and structural child rules, sorted. */
  types: Record<string, { attrs: string[]; children: string[] }>;
  /** "type.subType" (a core-owned `extends`) -> the attribute names and child rules it adds, sorted. */
  extends: Record<string, { attrs: string[]; children: string[] }>;
  /** Types core registers in code, with no spec file (the TypeScript registry check covers them). */
  registeredInCode: string[];
}

const childKey = (c: ChildDefLike): string => {
  const sub = Array.isArray(c.subType) ? c.subType.join("|") : (c.subType ?? "*");
  return `${c.type}.${sub}:${c.name}`;
};

function split(children: readonly ChildDefLike[] | undefined): { attrs: string[]; children: string[] } {
  const attrs: string[] = [];
  const kids: string[] = [];
  for (const c of children ?? []) {
    if (c.type === "attr") attrs.push(c.name);
    else kids.push(childKey(c));
  }
  return { attrs: attrs.sort(), children: kids.sort() };
}

function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "spec")) && existsSync(join(dir, "server"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Could not locate repo root (dir containing spec/ and server/)");
    dir = parent;
  }
}

/** Compute the pin from the spec files whose provider is the core provider. */
export function computeCorePin(specDir: string): CorePin {
  const pin: CorePin = { types: {}, extends: {}, registeredInCode: ["metadata.root"] };
  for (const f of readdirSync(specDir).filter((n) => n.endsWith(".json")).sort()) {
    const def = JSON.parse(readFileSync(join(specDir, f), "utf8")) as DefinitionLike;
    if (def.provider !== CORE_PROVIDER_ID) continue;
    for (const t of def.types ?? []) {
      // "*.*" is the common-attribute carrier, not a type.
      const key = `${t.type}.${t.subType}`;
      pin.types[key] = split(t.children);
    }
    for (const x of def.extends ?? []) {
      const subs = Array.isArray(x.subType) ? x.subType : [x.subType];
      for (const s of subs) pin.extends[`${x.type}.${s}`] = split(x.children);
    }
  }
  const sorted = <T>(o: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  pin.types = sorted(pin.types);
  pin.extends = sorted(pin.extends);
  return pin;
}

const serialize = (pin: CorePin): string => JSON.stringify({ $comment: COMMENT, ...pin }, null, 2) + "\n";

const COMMENT = [
  "The pinned vocabulary of the core provider (metaobjects-core-types): every type, subtype,",
  "attribute and structural child rule it owns. Derived from spec/metamodel/*.json by",
  "scripts/check-core-vocabulary-pin.ts. Do NOT regenerate this to make a failing gate pass:",
  "new vocabulary belongs in a pack (a separate provider), see GOVERNANCE.md, 'Extension packs",
  "and the core metamodel', and docs/features/extending-with-providers.md. Core takes a new",
  "type or attribute only once a second, independent consumer needs it, and that is a core",
  "maintainer's decision; the diff of this file is how that decision is reviewed.",
].join(" ");

/** Human-readable difference between the committed pin and the computed one; [] when equal. */
export function diffPins(committed: CorePin, computed: CorePin): string[] {
  const out: string[] = [];
  for (const section of ["types", "extends"] as const) {
    const a = committed[section];
    const b = computed[section];
    for (const k of Object.keys(b)) {
      if (!(k in a)) {
        out.push(`+ ${section === "types" ? "type" : "core extension of"} ${k}`);
        continue;
      }
      for (const field of ["attrs", "children"] as const) {
        for (const n of b[k]![field]) if (!a[k]![field].includes(n)) out.push(`+ ${k} ${field === "attrs" ? "attribute @" : "child rule "}${n}`);
        for (const n of a[k]![field]) if (!b[k]![field].includes(n)) out.push(`- ${k} ${field === "attrs" ? "attribute @" : "child rule "}${n}`);
      }
    }
    for (const k of Object.keys(a)) if (!(k in b)) out.push(`- ${section === "types" ? "type" : "core extension of"} ${k}`);
  }
  return out;
}

export const FAILURE_GUIDANCE = [
  "The core provider's vocabulary is pinned, and it changed (above).",
  "New vocabulary does not go in core: GOVERNANCE.md, 'Extension packs and the core metamodel',",
  "says core takes a new type, subtype or attribute only when a second, independent consumer",
  "needs it. Put it in a pack instead: its own provider and spec/metamodel/<pack>.json",
  "(provider id 'metaobjects-<pack>'), composed by default if it ships with the library, so a",
  "project can leave it out. See docs/features/extending-with-providers.md and the worked",
  "examples (metaobjects-rules, metaobjects-view-expressions).",
  "Only if a core maintainer has decided this belongs in core, regenerate the pin with",
  "`bun scripts/check-core-vocabulary-pin.ts --update` and justify it in the PR.",
].join("\n");

function main(): number {
  const argv = process.argv.slice(2);
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const specDir = arg("--spec") ?? join(root, "spec", "metamodel");
  const pinPath = arg("--pin") ?? join(root, "fixtures", "registry-conformance", "core-vocabulary.pin.json");
  const computed = computeCorePin(specDir);
  if (argv.includes("--update")) {
    writeFileSync(pinPath, serialize(computed), "utf8");
    console.log(`wrote ${pinPath}`);
    return 0;
  }
  if (!existsSync(pinPath)) {
    console.error(`core vocabulary pin missing: ${pinPath}\n${FAILURE_GUIDANCE}`);
    return 1;
  }
  const committed = JSON.parse(readFileSync(pinPath, "utf8")) as CorePin;
  const diff = diffPins(committed, computed);
  if (diff.length > 0) {
    console.error(`core vocabulary changed:\n${diff.map((d) => `  ${d}`).join("\n")}\n\n${FAILURE_GUIDANCE}`);
    return 1;
  }
  const n = Object.keys(computed.types).length;
  console.log(`core vocabulary pin ok (${n} types owned by ${CORE_PROVIDER_ID}).`);
  return 0;
}

if (import.meta.main) process.exit(main());
