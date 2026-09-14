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

/**
 * Each port's generated embed, and how a KEY is written in it.
 *
 * Kotlin has no embed of its own — it runs on the JVM and reads Java's, which is why it
 * maps onto that file.
 *
 * The pattern matches a key POSITION, not the key text anywhere in the file, and that
 * distinction is the whole point. Every embedded value is the library's own YAML, and
 * that YAML talks about its own ref: `library/ai/db.yaml` opens with "Opted into as
 * `\"ai/db\"`". So a substring search for `"ai/db"` hits the payload and passes even if
 * the key is deleted — which is what this file used to do. A key is line-initial (or
 * follows `.put(`) and contains no backslash; a payload mention is mid-string and
 * escaped. Excluding `\\` from the captured class is what separates them.
 */
const EMBEDS: Record<string, { path: string; key: RegExp }> = {
  typescript: {
    path: "server/typescript/packages/metadata/src/library/embedded-library.generated.ts",
    key: /^[ \t]*"([^"\\]+)":[ \t]*"/gm,
  },
  java: {
    path: "server/java/metadata/src/main/java/com/metaobjects/library/EmbeddedLibrary.java",
    key: /\.put\("([^"\\]+)",[ \t]*"/g,
  },
  kotlin: {
    path: "server/java/metadata/src/main/java/com/metaobjects/library/EmbeddedLibrary.java",
    key: /\.put\("([^"\\]+)",[ \t]*"/g,
  },
  csharp: {
    path: "server/csharp/MetaObjects/Library/EmbeddedLibrary.cs",
    key: /^[ \t]*\["([^"\\]+)"\][ \t]*=[ \t]*"/gm,
  },
  python: {
    path: "server/python/src/metaobjects/library/embedded_library.py",
    key: /^[ \t]*['"]([^'"\\]+)['"]:[ \t]*['"]/gm,
  },
};

/**
 * The keys one port's embed actually declares, split by the two records it carries:
 * refs (`<library>/<layer>`) and manifests (a bare library name).
 */
function extractKeys(text: string, key: RegExp): { refs: Set<string>; manifests: Set<string> } {
  const refs = new Set<string>();
  const manifests = new Set<string>();
  for (const m of text.matchAll(key)) {
    const k = m[1]!;
    (k.includes("/") ? refs : manifests).add(k);
  }
  return { refs, manifests };
}

function embeddedKeys(port: string): { refs: Set<string>; manifests: Set<string> } {
  const entry = EMBEDS[port];
  if (entry === undefined) throw new Error(`no embed mapping for port "${port}"`);
  return extractKeys(readFileSync(join(findRepoRoot(import.meta.dir), entry.path), "utf8"), entry.key);
}

/** Every ref every shipped library declares, across all its layers. */
function declaredRefs(name: string): string[] {
  return Object.values(MANIFESTS[name]?.layers ?? {}).flatMap((l) => [...l.refs]);
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
      // is the single fact a polyglot adopter acts on.
      const refs = declaredRefs(name);
      expect(refs.length, `${name} declares no refs at all`).toBeGreaterThan(0);
      for (const port of SERVER_LANGS) {
        const embedded = embeddedKeys(port).refs;
        for (const ref of refs) {
          expect([...embedded].includes(ref), `${port} does not embed ${ref}`).toBe(true);
        }
      }
    });
  }

  test("every port's embed carries EXACTLY the declared refs and manifests", () => {
    // The per-library test above proves nothing is MISSING. This one proves nothing is
    // extra and, just as importantly, that the extractor is not matching nothing: a key
    // pattern that silently stops matching would make every containment check above
    // vacuously true, which is the way a gate of this shape stops gating.
    expect(Object.keys(EMBEDS).sort(), "a port with no embed mapping").toEqual([...SERVER_LANGS].sort());
    const allRefs = NAMES.flatMap(declaredRefs).sort();
    expect(allRefs.length, "no library declares any ref").toBeGreaterThan(0);

    for (const port of SERVER_LANGS) {
      const { refs, manifests } = embeddedKeys(port);
      expect([...refs].sort(), `${port} embeds a different ref set`).toEqual(allRefs);
      expect([...manifests].sort(), `${port} embeds a different manifest set`).toEqual(NAMES);
    }
  });

  describe("the key extractor reads a POSITION, not a spelling", () => {
    // What this replaced was `text.includes(`"${ref}"`)` over the same files. That check
    // is not currently wrong — every embedded payload escapes its own quotes, so a ref
    // named in a comment reads as `\\"ai/db\\"` and the bare `"ai/db"` occurs exactly once,
    // as the key. It is fragile rather than broken: it cannot see an EXTRA key, it cannot
    // tell the ref record from the manifest record, and it holds only for as long as the
    // generator keeps escaping payloads the way it does today.
    //
    // The extractor does not depend on that. A key is a POSITION — line-initial, or after
    // `.put(` — so a mention anywhere inside a value is not a key however it is spelled.
    // These fixtures pin that, including the unescaped case a change to the generator
    // would produce, where a substring check WOULD produce a false positive.
    const ESCAPED = JSON.stringify('"ai/db"').slice(1, -1); // \"ai/db\"

    /** One line of each record, in that port's syntax, for an arbitrary ref key. */
    const SYNTHETIC: Record<string, (ref: string) => string> = {
      typescript: (ref) => `  "${ref}": "# Opted into as ${ESCAPED}.",\n  "ai": "{}",\n`,
      java: (ref) => `        m.put("${ref}", "# Opted into as ${ESCAPED}.");\n        n.put("ai", "{}");\n`,
      csharp: (ref) => `        ["${ref}"] = "# Opted into as ${ESCAPED}.",\n        ["ai"] = "{}",\n`,
      python: (ref) => `    '${ref}': '# Opted into as ${ESCAPED}.',\n    'ai': '{}',\n`,
    };

    test("every port with an embed has a synthetic fixture", () => {
      // Kotlin shares Java's file and Java's syntax, so Java's row covers it.
      expect(Object.keys(SYNTHETIC).sort()).toEqual(
        [...SERVER_LANGS].filter((l) => l !== "kotlin").sort(),
      );
    });

    for (const [port, line] of Object.entries(SYNTHETIC)) {
      test(`${port}: a key is extracted; a mention inside a value is not`, () => {
        const re = EMBEDS[port]!.key;

        const present = extractKeys(line("ai/db"), re);
        expect([...present.refs], `${port}: the real key was not extracted`).toEqual(["ai/db"]);
        expect([...present.manifests], `${port}: the manifest key was not extracted`).toEqual(["ai"]);

        // Same text, different KEY; the payload still names `ai/db`, escaped as today.
        expect([...extractKeys(line("ai/model"), re).refs], `${port}: an escaped mention read as a key`)
          .toEqual(["ai/model"]);

        // And unescaped — what a change to the generator's string handling would emit.
        // Here the substring a raw check looks for IS present, and is still not a key.
        const unescaped = line("ai/model").replaceAll(ESCAPED, '"ai/db"');
        expect(unescaped.includes('"ai/db"'), `${port}: fixture did not produce a bare mention`).toBe(true);
        expect([...extractKeys(unescaped, re).refs], `${port}: a bare mention read as a key`)
          .toEqual(["ai/model"]);
      });
    }
  });

  test("a library name and a generator stable name share ONE namespace", () => {
    // They are rows in one table, and `meta eject <name>` takes either. A collision
    // would make the catalog ambiguous in exactly the place an agent acts on it.
    const collisions = NAMES.filter((n) => n in composeCatalog());
    expect(collisions, `library names that are also generator names: ${collisions.join(", ")}`).toEqual([]);
  });
});
