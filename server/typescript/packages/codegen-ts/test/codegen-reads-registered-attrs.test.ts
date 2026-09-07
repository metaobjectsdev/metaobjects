// Every attribute name codegen reads off metadata must be REGISTERED vocabulary.
//
// WHY THIS EXISTS. `meta gen` loads non-strict and `meta verify` loads strict, so a
// generator can read an attribute no provider registers and the project sees a working
// `gen` beside a red `verify` — with the attribute DOCUMENTED, because whoever added the
// read also wrote it up. It has happened twice: the five `@emit*` per-entity switches and
// the seven attributes removed in 0.25.0. Both shipped as documented mechanisms that
// failed the drift gate documented beside them.
//
// The existing `retired-codegen-attrs.test.ts` pins those specific names. That proves the
// known ones are gone; it cannot see the NEXT one. This gate asks the general question
// instead, so the class is closed rather than the instances.
//
// THE BAR IS REGISTRATION, NOT THE CORE MANIFEST. `expected-registry.json` is the
// byte-gated core set, but the TS web tier legitimately registers its own view attrs
// through the `metaobjects-ui-web` concern provider (FR-033 keeps core `view.*` at zero
// attrs deliberately), and those reads are correct. So the permitted set is the union:
// core manifest + the TS-applied provider specs. A read outside BOTH is the defect.

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../../..");

/** Every `.ts` under `dir`, skipping build output and dependencies. */
function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== "node_modules" && entry !== "dist") sources(p, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** Attribute names the core manifest registers, across every type plus the common bag. */
function coreAttrNames(): Set<string> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "fixtures/registry-conformance/expected-registry.json"), "utf8"),
  ) as { types: { attrs?: { name: string }[] }[]; commonAttrs?: { name: string }[] };
  const names = new Set<string>();
  for (const t of manifest.types) for (const a of t.attrs ?? []) names.add(a.name);
  for (const a of manifest.commonAttrs ?? []) names.add(a.name);
  return names;
}

/**
 * Attribute names a concern-provider spec registers. These declare attrs as `attr.*`
 * CHILDREN of the type they extend, not under an `attrs` key — a shape difference that
 * matters: a reader that only understands `attrs` sees an empty provider and reports its
 * legitimately-registered reads as defects.
 */
function providerAttrNames(specPath: string): Set<string> {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (typeof node !== "object" || node === null) return;
    const o = node as Record<string, unknown>;
    if (o.type === "attr" && typeof o.name === "string") names.add(o.name);
    for (const v of Object.values(o)) walk(v);
  };
  walk(JSON.parse(readFileSync(join(REPO_ROOT, specPath), "utf8")));
  return names;
}

/** `export const NAME = "value"` across the metadata package's constants modules. */
function metamodelConstants(): Map<string, string> {
  const consts = new Map<string, string>();
  for (const f of sources(join(REPO_ROOT, "server/typescript/packages/metadata/src"))) {
    if (!f.endsWith("-constants.ts")) continue;
    for (const m of readFileSync(f, "utf8").matchAll(/export const ([A-Z0-9_]+)\s*=\s*"([^"]*)"/g)) {
      consts.set(m[1] as string, m[2] as string);
    }
  }
  return consts;
}

/** The packages that emit code from metadata. */
const CODEGEN_PACKAGES = ["codegen-ts", "codegen-ts-react", "codegen-ts-tanstack", "codegen-ts-angular"];

/** `.attr(X)` / `.ownAttr(X)`, where X is a string literal or a CONSTANT_NAME. */
const ATTR_READ = /\.(?:own)?[Aa]ttr\(\s*(?:"([^"]+)"|([A-Z0-9_]+))\s*[,)]/g;

interface Read { file: string; token: string; name: string | undefined }

function attrReads(): Read[] {
  const consts = metamodelConstants();
  const reads: Read[] = [];
  for (const pkg of CODEGEN_PACKAGES) {
    for (const f of sources(join(REPO_ROOT, "server/typescript/packages", pkg, "src"))) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(ATTR_READ)) {
        const file = relative(REPO_ROOT, f);
        if (m[1] !== undefined) reads.push({ file, token: `"${m[1]}"`, name: m[1] });
        else reads.push({ file, token: m[2] as string, name: consts.get(m[2] as string) });
      }
    }
  }
  return reads;
}

describe("codegen reads only registered attributes", () => {
  test("every attribute name a generator reads is registered vocabulary", () => {
    const permitted = new Set([
      ...coreAttrNames(),
      // TS-only web tier. FR-033 keeps core `view.*` at zero attrs on purpose, so these
      // are registered HERE and nowhere else — and they are still registered.
      ...providerAttrNames("spec/metamodel/ui-web.json"),
    ]);

    const offenders = attrReads()
      .filter((r) => r.name !== undefined && !permitted.has(r.name))
      .map((r) => `  ${r.file}: ${r.token}${r.token.startsWith('"') ? "" : ` = "${r.name}"`}`);

    expect(
      [...new Set(offenders)].join("\n"),
      "A generator reads an attribute no provider registers. `meta gen` loads non-strict " +
        "so this works, and `meta verify` loads strict so an adopter's drift gate goes red " +
        "on metadata the docs told them to write — the @emit* defect. Register it in a " +
        "provider, or derive the value instead of asking for an attribute.",
    ).toBe("");
  });

  test("every constant a read names actually resolves", () => {
    // Without this the gate degrades silently: an unresolvable token yields `name:
    // undefined`, the filter above skips it, and a whole package could go unchecked while
    // the suite stays green. An unresolved name is a gate failure, not a pass.
    const unresolved = [...new Set(
      attrReads().filter((r) => r.name === undefined).map((r) => `  ${r.file}: ${r.token}`),
    )];
    expect(unresolved.join("\n"), "Attribute-read constants that resolved to nothing").toBe("");
  });

  test("the scan actually reaches the generators — it is not matching nothing", () => {
    // A regex that stops matching would make both checks above pass vacuously. Pin a
    // floor, and pin that more than one package is reached, so a broken path glob shows up
    // as a failure rather than as silence.
    const reads = attrReads();
    expect(reads.length).toBeGreaterThan(100);
    // server/typescript/packages/<pkg>/src/... — index 3 is the package name.
    const packagesSeen = new Set(reads.map((r) => r.file.split("/")[3]));
    expect(packagesSeen.size).toBeGreaterThan(1);
  });
});
