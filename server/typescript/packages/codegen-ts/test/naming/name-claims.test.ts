// The run's one claim registry (ruling R52). Each generator claims the names it emits, in the
// scope they live in, as it emits them: a module's type and collection names in its directory,
// the barrel's re-exports in the barrel, a REST segment in its routes entry. A real duplicate is
// refused (ERR_NAME_COLLISION) naming both claimants and the remedy; nothing is renamed; and a
// generator that is not wired claims nothing, so a docs-only run refuses nothing.

import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { runGen } from "../../src/runner.js";
import { defineConfig } from "../../src/metaobjects-config.js";
import type { Generator } from "../../src/generator.js";
import { NameClaims, ERR_NAME_COLLISION } from "../../src/naming/name-claims.js";
import { docsFile } from "../../src/generators/docs-file.js";
import { apiDocsFile } from "../../src/generators/api-docs-file.js";
import { entityFile } from "../../src/generators/entity-file.js";
import { queriesFile } from "../../src/generators/queries-file.js";
import { routesFile } from "../../src/generators/routes-file.js";
import { routesFileHono } from "../../src/generators/routes-file-hono.js";
import { barrel } from "../../src/generators/barrel.js";
import type { OutputLayout } from "../../src/import-path.js";

type Json = Record<string, unknown>;

const entity = (name: string, extra: { abstract?: boolean; source?: boolean } = {}): Json => ({
  "object.entity": {
    name,
    ...(extra.abstract === true ? { abstract: true } : {}),
    children: [
      ...(extra.source === false ? [] : [{ "source.rdb": { "@table": `t_${name.toLowerCase()}` } }]),
      { "field.long": { name: "id" } },
      { "identity.primary": { "@fields": "id", "@generation": "increment" } },
    ],
  },
});
const value = (name: string, field: string): Json => ({
  "object.value": { name, children: [{ "field.string": { name: field, "@required": true } }] },
});

/** One source per package, so each object lives in its own package. */
async function load(...packages: { pkg: string; children: Json[] }[]) {
  const res = await new MetaDataLoader().load(packages.map((p, i) => new InMemoryStringSource(
    JSON.stringify({ "metadata.root": { package: p.pkg, children: p.children } }),
    { id: `m${i}.json`, format: "json" },
  )));
  expect(res.errors).toEqual([]);
  return res.root;
}

/** Run `generators` into a temp dir; resolves to the written files (relative path → content). */
async function run(
  root: Awaited<ReturnType<typeof load>>,
  generators: Generator[],
  outputLayout: OutputLayout | "default" = "flat",
): Promise<Map<string, string>> {
  const tmp = mkdtempSync(join(tmpdir(), "name-claims-"));
  try {
    await runGen({
      config: defineConfig({
        outDir: join(tmp, "src"), extStyle: "js", dbImport: "../db", dialect: "sqlite",
        ...(outputLayout !== "default" && { outputLayout }),
        targets: { docs: { outDir: join(tmp, "docs") } }, generators,
      }),
      metadata: root, projectRoot: tmp,
    });
    const out = new Map<string, string>();
    const src = join(tmp, "src");
    if (!existsSync(src)) return out;
    for (const e of readdirSync(src, { recursive: true, withFileTypes: true })) {
      if (e.isFile()) out.set(relative(src, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8"));
    }
    return out;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

describe("NameClaims", () => {
  test("the first claimant owns a name; the same claimant again is not a collision", () => {
    const claims = new NameClaims();
    claims.claim("scope A", "Note", "acme::alpha::Note", "rename one");
    expect(() => claims.claim("scope A", "Note", "acme::alpha::Note", "rename one")).not.toThrow();
  });

  test("a second claimant in the same scope is refused, naming both and the remedy", () => {
    const claims = new NameClaims();
    claims.claim("scope A", "Note", "acme::alpha::Note", "rename one");
    expect(() => claims.claim("scope A", "Note", "acme::beta::Note", "rename one")).toThrow(
      `${ERR_NAME_COLLISION}: "acme::alpha::Note" and "acme::beta::Note" both generate "Note" in scope A — rename one.`,
    );
  });

  test("one name in two scopes is two names", () => {
    const claims = new NameClaims();
    claims.claim("scope A", "Note", "acme::alpha::Note", "rename one");
    expect(() => claims.claim("scope B", "Note", "acme::beta::Note", "rename one")).not.toThrow();
  });
});

describe("the claims follow the wired generators", () => {
  const twins = (a: string, b: string) => load({ pkg: "acme", children: [entity(a), entity(b)] });

  test("a docs-only run claims nothing, so it refuses neither a module-name nor a route collision", async () => {
    // Address / Addresses share one pluralized name AND one REST segment ("addresses").
    await run(await twins("Address", "Addresses"), [docsFile(), apiDocsFile()]);
  });

  test("the entity modules claim the collection name", async () => {
    await expect(run(await twins("Address", "Addresses"), [entityFile()])).rejects.toThrow(
      new RegExp(`${ERR_NAME_COLLISION}: "acme::Address" and "acme::Addresses" both generate "Addresses" in the collection names of the module directory`),
    );
  });

  test("the queries modules claim it too", async () => {
    await expect(run(await twins("Order", "Orders"), [queriesFile()])).rejects.toThrow(
      new RegExp(`${ERR_NAME_COLLISION}.*"Orders"`),
    );
  });

  test("a REST segment is claimed only when a routes generator is wired", async () => {
    // ApiKey / APIKey: distinct pluralized names, one REST segment.
    await run(await twins("ApiKey", "APIKey"), [entityFile()]);
    await expect(run(await twins("ApiKey", "APIKey"), [entityFile(), routesFile()])).rejects.toThrow(
      /both generate "api_keys" in the REST collection segments of routes entry #2/,
    );
    await expect(run(await twins("ApiKey", "APIKey"), [routesFileHono()])).rejects.toThrow(/"api_keys"/);
  });

  test("a value object claims its type but no collection", async () => {
    const root = await load({ pkg: "acme", children: [entity("Address"), value("Addresses", "text")] });
    await run(root, [entityFile(), routesFile()]);
  });

  test("an abstract or sourceless twin gets no route, so it claims no segment", async () => {
    for (const twin of [entity("APIKey", { abstract: true, source: false }), entity("APIKey", { source: false })]) {
      await run(await load({ pkg: "acme", children: [entity("ApiKey"), twin] }), [routesFile()]);
    }
  });
});

describe("fixtures/naming-conformance/already-plural-pluralize.json", () => {
  type NamedObject = { package: string; name: string; abstract?: boolean; source?: boolean };
  const corpus = JSON.parse(readFileSync(resolve(
    import.meta.dir, "..", "..", "..", "..", "..", "..",
    "fixtures", "naming-conformance", "already-plural-pluralize.json",
  ), "utf8")) as {
    collisionCases: { entityA: string; entityB: string; collidesOn: string }[];
    shapeOnlyCases: { shapeOnly: NamedObject; emitting: NamedObject; note: string }[];
    crossPackageCollisionCases: { entityA: NamedObject; entityB: NamedObject; collidesOn: string }[];
  };
  const packaged = (...objects: NamedObject[]) =>
    load(...objects.map((o) => ({ pkg: o.package, children: [entity(o.name, o)] })));
  const all = (): Generator[] => [entityFile(), queriesFile(), routesFile()];

  for (const c of corpus.collisionCases) {
    test(`refused: ${c.entityA} / ${c.entityB} on "${c.collidesOn}"`, async () => {
      const root = await load({ pkg: "acme", children: [entity(c.entityA), entity(c.entityB)] });
      await expect(run(root, all())).rejects.toThrow(new RegExp(`${ERR_NAME_COLLISION}.*"${c.collidesOn}"`));
    });
  }

  for (const c of corpus.shapeOnlyCases) {
    test(`accepted: ${c.note}`, async () => {
      // Both orders: the first claimant owns a name, so order must not matter. The package
      // layout puts the abstract shape's own module in its own package directory.
      await run(await packaged(c.shapeOnly, c.emitting), all(), "package");
      await run(await packaged(c.emitting, c.shapeOnly), all(), "package");
    });
  }

  test("two emitting entities of one name in two packages: one module directory under the flat layout", async () => {
    for (const c of corpus.crossPackageCollisionCases) {
      await expect(run(await packaged(c.entityA, c.entityB), [entityFile()])).rejects.toThrow(
        new RegExp(`${ERR_NAME_COLLISION}.*"${c.entityA.name}" in the module directory "\\."`),
      );
    }
  });

  test("under the package layout their modules are two scopes, but one routes entry still serves one segment", async () => {
    for (const c of corpus.crossPackageCollisionCases) {
      const root = await packaged(c.entityA, c.entityB);
      await run(root, [entityFile(), queriesFile()], "package");
      await expect(run(root, all(), "package")).rejects.toThrow(new RegExp(`"${c.collidesOn}" in the REST collection segments`, "i"));
    }
  });
});

describe("a value object is never renamed", () => {
  const twoNotes = () => load(
    { pkg: "acme::alpha", children: [value("Note", "alphaText")] },
    { pkg: "acme::beta", children: [value("Note", "betaText")] },
    {
      pkg: "acme::app",
      children: [{
        "object.value": {
          name: "Digest",
          children: [
            { "field.object": { name: "fromAlpha", "@objectRef": "acme::alpha::Note" } },
            { "field.object": { name: "fromBeta", "@objectRef": "acme::beta::Note" } },
          ],
        },
      }],
    },
  );

  test("under the package layout two same-named value objects are two modules, each declaring its own name", async () => {
    const files = await run(await twoNotes(), [entityFile()], "package");
    expect(files.get("acme/alpha/Note.ts")).toContain("export interface Note {");
    expect(files.get("acme/alpha/Note.ts")).toContain("alphaText: string;");
    expect(files.get("acme/beta/Note.ts")).toContain("export interface Note {");
    expect(files.get("acme/beta/Note.ts")).toContain("betaText: string;");
    // The file that meets both binds each under a package-qualified local alias.
    const digest = files.get("acme/app/Digest.ts")!;
    expect(digest).toMatch(/import \{\s*type Note as AcmeAlphaNote,\s*NoteInsertSchema as AcmeAlphaNoteInsertSchema,\s*\} from "\.\.\/alpha\/Note\.js";/);
    expect(digest).toMatch(/import \{\s*type Note as AcmeBetaNote,\s*NoteInsertSchema as AcmeBetaNoteInsertSchema,\s*\} from "\.\.\/beta\/Note\.js";/);
    expect(digest).toContain("fromAlpha?: AcmeAlphaNote | undefined;");
    expect(digest).toContain("fromBeta?: AcmeBetaNote | undefined;");
    for (const content of files.values()) {
      expect(content).not.toContain("interface AcmeAlphaNote");
      expect(content).not.toContain("interface AcmeBetaNote");
    }
  });

  test("with no outputLayout declared each takes its package's directory (the default is package, R63)", async () => {
    await expect(run(await twoNotes(), [entityFile()], "default")).resolves.toBeDefined();
  });

  test("under the flat layout they share one module directory, and the collision is refused naming both", async () => {
    await expect(run(await twoNotes(), [entityFile()])).rejects.toThrow(
      `${ERR_NAME_COLLISION}: "acme::alpha::Note" and "acme::beta::Note" both generate "Note" in the module directory "." of target "default"`,
    );
  });

  test("a barrel re-exports every module in one namespace, so it refuses them under the package layout too", async () => {
    await expect(run(await twoNotes(), [entityFile(), barrel()], "package")).rejects.toThrow(
      /both generate "Note" in the barrel \(index\.ts\) of target "default" — rename one, or drop the barrel/,
    );
  });
});
