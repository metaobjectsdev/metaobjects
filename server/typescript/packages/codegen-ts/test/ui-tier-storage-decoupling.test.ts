// The UI tier must not reach through to storage.
//
// Hooks, grids and forms are clients of a REST endpoint. They never touch a database
// and `@metaobjectsdev/runtime-web` deliberately carries no database dependency — so
// the question a UI generator asks is "is there an endpoint?", never "is there a
// relational source?".
//
// Those two coincide TODAY only because routes are derived from sources (FR-008/009).
// The coincidence ends with FR-024 declared `api.*` surfaces and #211 non-RDB
// materialization, at which point a UI generator asking the storage question starts
// refusing to emit hooks for entities that genuinely do have endpoints. The reach-
// through therefore lives in exactly one file, `api-surface.ts`, named for what it
// means — and this test is what keeps it there.
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { servesReadApi, servesWriteApi } from "../src/api-surface.js";

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..");

/** Every UI-tier generator source file: the packages that emit browser code. */
function uiTierSources(): Array<{ file: string; body: string }> {
  const out: Array<{ file: string; body: string }> = [];
  for (const pkg of ["codegen-ts-tanstack", "codegen-ts-react"]) {
    const dir = join(REPO, "server", "typescript", "packages", pkg, "src");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      out.push({ file: `${pkg}/src/${name}`, body: readFileSync(join(dir, name), "utf8") });
    }
  }
  return out;
}

describe("UI tier ↔ storage decoupling", () => {
  test("no UI generator names a storage predicate", () => {
    // `hasAnyRdbSource` / `hasWritableRdbSource` are STORAGE questions. A UI generator
    // reaching for one is the coupling this guards against — it must go through
    // servesReadApi / servesWriteApi instead, so the day route derivation changes,
    // one file changes and the UI follows.
    const sources = uiTierSources();
    expect(sources.length).toBeGreaterThan(0);   // a silent empty scan proves nothing
    const offenders = sources
      .filter((s) => /\bhas(Any|Writable)RdbSource\b/.test(s.body))
      .map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  test("the UI predicates answer the ENDPOINT question, across every object shape", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({
      "metadata.root": { package: "acme", children: [
        { "object.entity": { name: "Sourced", children: [
          { "source.rdb": { "@table": "sourced" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        ] } },
        { "object.projection": { name: "ViewBacked", children: [
          { "source.rdb": { "@kind": "view", "@table": "v_sourced" } },
          { "field.long": { name: "id", extends: "Sourced.id" } },
          { "identity.primary": { name: "pk", extends: "Sourced.pk" } },
        ] } },
        { "object.value": { name: "Payload", children: [{ "field.string": { name: "text" } }] } },
        { "object.entity": { name: "Sourceless", children: [
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        ] } },
        // `abstract` is a BARE reserved keyword in canonical JSON, not an @-attr.
        { "object.entity": { name: "AbstractBase", abstract: true, children: [
          { "source.rdb": { "@table": "abstract_base" } },
          { "field.long": { name: "id" } },
        ] } },
      ] },
    }))]);
    expect(errors).toEqual([]);
    const o = (n: string) => root.objects().find((x) => x.name === n)!;

    // READ endpoints: the sourced entity and the VIEW-BACKED projection. The projection
    // is the row that matters — it is read-only, but it has an endpoint, so its hooks
    // must keep being generated.
    expect(servesReadApi(o("Sourced"))).toBe(true);
    expect(servesReadApi(o("ViewBacked"))).toBe(true);
    expect(servesReadApi(o("Payload"))).toBe(false);
    expect(servesReadApi(o("Sourceless"))).toBe(false);
    expect(servesReadApi(o("AbstractBase"))).toBe(false);

    // WRITE endpoints: only the writable entity. A view-backed projection has a read
    // endpoint but nothing to submit to.
    expect(servesWriteApi(o("Sourced"))).toBe(true);
    expect(servesWriteApi(o("ViewBacked"))).toBe(false);
    expect(servesWriteApi(o("Payload"))).toBe(false);
    expect(servesWriteApi(o("Sourceless"))).toBe(false);
    expect(servesWriteApi(o("AbstractBase"))).toBe(false);
  });

  test("the browser runtime carries no database dependency", () => {
    // The layering claim, checked at the manifest rather than asserted in prose.
    for (const pkg of ["runtime-web", "react", "tanstack"]) {
      const manifest = join(REPO, "client", "web", "packages", pkg, "package.json");
      if (!existsSync(manifest)) continue;
      const { dependencies = {}, peerDependencies = {} } =
        JSON.parse(readFileSync(manifest, "utf8")) as Record<string, Record<string, string>>;
      const named = [...Object.keys(dependencies), ...Object.keys(peerDependencies)];
      for (const db of ["drizzle-orm", "kysely", "pg", "better-sqlite3", "@libsql/client"]) {
        expect(`${pkg}:${named.includes(db)}`).toBe(`${pkg}:false`);
      }
    }
  });
});
