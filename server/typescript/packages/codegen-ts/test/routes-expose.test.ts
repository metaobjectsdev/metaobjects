// #348 — a generated routes file must be able to mount fewer than five CRUD verbs.
//
// `expose` has always existed on the runtime mount helpers, but across BOTH generated
// route emitters exactly one call site passed it: the TPH polymorphic mount's hardcoded
// `["list", "get"]`. For a vanilla or write-through entity neither Fastify nor Hono could
// restrict verbs — so a project whose tables are written through narrow audited paths had
// to either not wire the generator or hand-edit its output, while the file it emitted
// carried a comment inviting the next reader to "register this as-is for stock CRUD".
//
// This is a generator OPTION rather than the "narrow it with `filter`" remedy that
// answered the retired @emit* attributes, because `filter` structurally cannot express
// it: filter decides whether the file emits AT ALL, per entity, so it can only remove the
// whole surface. Same reasoning that made a TPH subtype's opt-IN grid `tphSubtypeGrids`.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { renderRoutesFile } from "../src/templates/routes-file.js";
import { renderRoutesFileHono } from "../src/templates/routes-file-hono.js";
import { CRUD_VERBS, resolveExpose, intersectExpose } from "../src/routes-expose.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      // TPH base + subtype: the polymorphic mount is read-only BY CONSTRUCTION.
      { "object.entity": { name: "Auth", "@discriminator": "type", children: [
        { "source.rdb": { "@table": "auths" } },
        { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "BridgeAuth", extends: "Auth", "@discriminatorValue": "Bridge",
        children: [{ "field.int": { name: "quantity" } }] } },
      // Vanilla, write-target-only: the audit-log shape the issue describes.
      { "object.entity": { name: "AuditEntry", children: [
        { "source.rdb": { "@table": "audit_entries" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "actor" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Customer", children: [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
    ],
  },
});

async function load(): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  expect(errors).toEqual([]);
  return root;
}

function ctxFor(root: MetaRoot) {
  return makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp/x", dbImport: "./db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
}

const entityOf = (root: MetaRoot, name: string): MetaObject =>
  root.objects().find((o) => o.name === name)!;

describe("#348 — expose narrows the generated CRUD surface", () => {
  test("absent expose emits no expose key at all, on both emitters", async () => {
    const root = await load();
    const ctx = ctxFor(root);
    const audit = entityOf(root, "AuditEntry");
    // Byte-identical output for every project that does not use the option is the
    // whole reason this emits nothing rather than the full five-verb list.
    expect(renderRoutesFile(audit, ctx)).not.toContain("expose:");
    expect(renderRoutesFileHono(audit, ctx)).not.toContain("expose:");
  });

  test("a verb list reaches the Fastify mount", async () => {
    const root = await load();
    const out = renderRoutesFile(entityOf(root, "AuditEntry"), ctxFor(root), ["list", "get"]);
    expect(out).toContain('expose: ["list", "get"],');
  });

  test("a verb list reaches the Hono mount — the emitter the issue named", async () => {
    const root = await load();
    const out = renderRoutesFileHono(entityOf(root, "AuditEntry"), ctxFor(root), ["list", "get"]);
    expect(out).toContain('expose: ["list", "get"],');
  });

  test("the option resolves per entity when given a function", async () => {
    const root = await load();
    const expose = (e: MetaObject) =>
      e.name === "AuditEntry" ? (["list", "get"] as const) : undefined;
    const ctx = ctxFor(root);
    expect(renderRoutesFile(entityOf(root, "AuditEntry"), ctx, resolveExpose(entityOf(root, "AuditEntry"), expose)))
      .toContain('expose: ["list", "get"],');
    // A different entity keeps the full surface, and emits nothing.
    expect(renderRoutesFile(entityOf(root, "Customer"), ctx, resolveExpose(entityOf(root, "Customer"), expose)))
      .not.toContain("expose:");
  });
});

describe("#348 — a fixed read-only mount narrows but never widens", () => {
  test("the TPH polymorphic mount stays list/get when nothing is asked", async () => {
    const root = await load();
    const out = renderRoutesFile(entityOf(root, "Auth"), ctxFor(root));
    expect(out).toContain('expose: ["list", "get"],');
  });

  test("expose can narrow the polymorphic mount further", async () => {
    const root = await load();
    const out = renderRoutesFile(entityOf(root, "Auth"), ctxFor(root), ["list"]);
    expect(out).toContain('expose: ["list"],');
  });

  test("expose can NOT widen it — asking for create yields an empty set, not a write route", () => {
    // The discriminated union has no single writable shape, so mounting create there
    // would emit a route that fails at runtime. A wrong endpoint is worse than a
    // missing one, so the fixed set intersects rather than being replaced.
    expect(intersectExpose(["list", "get"], ["list", "create"])).toEqual(["list"]);
    expect(intersectExpose(["list", "get"], ["create", "delete"])).toEqual([]);
    expect(intersectExpose(["list", "get"], undefined)).toEqual(["list", "get"]);
  });
});

describe("#348 — the verb vocabulary cannot drift from the runtime it calls", () => {
  test("CRUD_VERBS matches the CrudVerb union both mount helpers declare", () => {
    // codegen-ts does not depend on runtime-ts (it EMITS a call, it never links), so the
    // union is restated here. Nothing compared the two — which is precisely how the
    // cell-renderer keys drifted from the view-subtype registry (#355). Read the runtime
    // declarations as source and compare.
    // test/ -> codegen-ts -> packages
    const runtimeSrc = (rel: string) =>
      readFileSync(resolve(import.meta.dirname, "../../runtime-ts/src", rel), "utf8");
    for (const rel of ["fastify/index.ts", "hono/index.ts"]) {
      const src = runtimeSrc(rel);
      const m = src.match(/export type CrudVerb\s*=\s*([^;]+);/);
      expect(m).not.toBeNull();
      const declared = [...(m?.[1] ?? "").matchAll(/"(\w+)"/g)]
        .map((x) => x[1])
        .filter((v): v is string => v !== undefined);
      expect(declared.length).toBeGreaterThan(0);   // the parse must not yield []
      expect(declared).toEqual([...CRUD_VERBS]);
    }
  });
});
