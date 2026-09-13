// FR-043 §4 — "every manifest fact is RESOLVED, not trusted".
//
// `library.json` is the record `meta gen --list` renders, and every field in it is a
// claim about something else: a package the library declares, a ref that is embedded,
// a generator the registry registers, a node the library ships. A manifest is the
// easiest kind of file to leave behind — nothing in a normal run reads it against
// reality — so each claim is checked against the thing it claims here.
//
// The one rule that is NOT about a single library is the last: a library name and a
// generator stable name live in ONE namespace, because they are rows in one table and
// `meta eject <name>` takes either.
import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MetaDataLoader, type MetaData } from "@metaobjectsdev/metadata";
import {
  libraryManifests, librarySources, knownLibraryTokens, splitLayerToken,
} from "@metaobjectsdev/metadata/library";
import { SERVER_LANGS } from "@metaobjectsdev/sdk";
import { composeCatalog } from "../src/lib/catalog.js";

const MANIFESTS = libraryManifests();
const NAMES = Object.keys(MANIFESTS).sort();

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "library")) && existsSync(join(dir, "server"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no repo root (a dir holding library/ and server/)");
    dir = parent;
  }
}

/** Load one library with every layer it declares. */
async function loadWhole(name: string): Promise<MetaData> {
  const tokens = knownLibraryTokens().filter((t) => splitLayerToken(t)[0] === name);
  const result = await new MetaDataLoader({ strict: true }).load(librarySources(tokens));
  expect(result.errors, `${name} loads clean`).toEqual([]);
  return result.root;
}

function packagesDeclaredIn(root: MetaData): Set<string> {
  const out = new Set<string>();
  const walk = (n: MetaData): void => {
    for (const c of n.children()) {
      const pkg = c.package ?? c.fileDefaultPackage ?? "";
      if (pkg !== "") out.add(pkg);
      walk(c);
    }
  };
  walk(root);
  return out;
}

function namesIn(root: MetaData): Set<string> {
  const out = new Set<string>();
  const walk = (n: MetaData): void => {
    for (const c of n.children()) {
      out.add(c.name);
      const pkg = c.package ?? c.fileDefaultPackage ?? "";
      if (pkg !== "") out.add(`${pkg}::${c.name}`);
      walk(c);
    }
  };
  walk(root);
  return out;
}

describe("every library manifest fact is resolved against the thing it claims", () => {
  test("there is at least one manifest to check", () => {
    expect(NAMES.length).toBeGreaterThan(0);
  });

  for (const name of NAMES) {
    const manifest = MANIFESTS[name]!;

    test(`${name}: the manifest key, the \`name\` field and the package's last segment agree`, () => {
      expect(manifest.name).toBe(name);
      for (const pkg of manifest.packages ?? []) {
        expect(pkg.split("::").pop(), `${pkg} should end in the library's own name`).toBe(name);
      }
    });

    test(`${name}: \`packages\` is exactly what the library declares — both ways`, async () => {
      const declared = packagesDeclaredIn(await loadWhole(name));
      const claimed = new Set(manifest.packages ?? []);
      // Both directions: a package claimed but empty is a promise the library does not
      // keep, and a package declared but unclaimed escapes the ownership refusal (§3.5)
      // that reads this list.
      expect([...declared].filter((p) => !claimed.has(p)).sort(), "declared but not claimed").toEqual([]);
      expect([...claimed].filter((p) => !declared.has(p)).sort(), "claimed but not declared").toEqual([]);
    });

    test(`${name}: every implied generator is a real stable name, and its anchor a real node`, async () => {
      const catalog = composeCatalog();
      const root = await loadWhole(name);
      const nodes = namesIn(root);
      for (const g of manifest.generators ?? []) {
        expect(catalog[g.name], `${name} implies generator "${g.name}", which nothing registers`).toBeDefined();
        if (g.anchor === undefined) continue;
        // The anchor is what retires the generator's hard-coded entity name, so it has
        // to resolve in the library it is declared by — not merely look plausible.
        expect(nodes.has(g.anchor), `${name}'s anchor "${g.anchor}" is not a node it ships`).toBe(true);
      }
    });

    test(`${name}: every layer's refs are embedded in EVERY port`, () => {
      // The row says `ports: [typescript, java, kotlin, csharp, python]`, and the basis
      // for that claim is that one generator script writes the embed for all of them.
      // Checked rather than asserted, because "the library is reachable from your port"
      // is the single fact a polyglot adopter acts on. Kotlin has no embed of its own —
      // it runs on the JVM and reads Java's, which is why it is mapped onto that file.
      const root = findRepoRoot(import.meta.dir);
      const EMBEDS: Record<string, string> = {
        typescript: "server/typescript/packages/metadata/src/library/embedded-library.generated.ts",
        java: "server/java/metadata/src/main/java/com/metaobjects/library/EmbeddedLibrary.java",
        kotlin: "server/java/metadata/src/main/java/com/metaobjects/library/EmbeddedLibrary.java",
        csharp: "server/csharp/MetaObjects/Library/EmbeddedLibrary.cs",
        python: "server/python/src/metaobjects/library/embedded_library.py",
      };
      expect(Object.keys(EMBEDS).sort(), "a port with no embed mapping").toEqual([...SERVER_LANGS].sort());

      const refs = Object.values(manifest.layers ?? {}).flatMap((l) => [...l.refs]);
      expect(refs.length, `${name} declares no refs at all`).toBeGreaterThan(0);
      for (const port of SERVER_LANGS) {
        const text = readFileSync(join(root, EMBEDS[port]!), "utf8");
        for (const ref of refs) {
          expect(text.includes(`"${ref}"`), `${port} does not embed ${ref}`).toBe(true);
        }
      }
    });
  }

  test("a library name and a generator stable name share ONE namespace", () => {
    // They are rows in one table, and `meta eject <name>` takes either. A collision
    // would make the catalog ambiguous in exactly the place an agent acts on it.
    const collisions = NAMES.filter((n) => n in composeCatalog());
    expect(collisions, `library names that are also generator names: ${collisions.join(", ")}`).toEqual([]);
  });
});
