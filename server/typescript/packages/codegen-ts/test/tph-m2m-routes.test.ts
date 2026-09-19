// M:N traversal inside a TPH hierarchy — the routes that were never mounted.
//
// `renderTphRoutesFile` emits the polymorphic mount and a full per-subtype CRUD set, but
// it never consulted the relation map, so every many-to-many navigation in a TPH
// hierarchy vanished from the generated API. Both sides were missing:
//
//   - declared on the BASE  — every row of the shared table is a legitimate source, so
//     the mount is the same one a vanilla entity gets;
//   - declared on a SUBTYPE — only that subtype's rows are, so the mount hangs under the
//     subtype's path segment AND has to prove the source id really is that subtype's.
//     The junction FK can only address the shared base table, so without that check a
//     sibling subtype's id reaches the same junction rows and the segment is decorative.
//
// None of this is a compile error. A route that is never mounted is an ABSENCE, which is
// why every port's codegen-compile gate stayed green while the endpoint 404'd — and why
// these assertions are over the emitted mount calls. The behaviour they describe — the
// booted routes answering over a real Postgres, sibling-subtype source ids included — is
// gated by the pairwise covering set (integration-tests, feature-combinations-pg.test.ts).
// A shared api-contract TPH+M:N fixture is planned as the cross-port capstone of the
// five-port pass; until it lands, that covering set is the behavioural evidence.
//
// Routes are deliberately not compiled here: fastify does not resolve from this package
// and its zod is a major behind runtime-ts, so the diagnostics drown the signal. That is
// the same line the codegen-compile gate draws.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { routesFile } from "../src/generators/routes-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { EmittedFile, GenContext } from "../src/generator.js";

const MODEL = {
  "metadata.root": {
    package: "acme::auth",
    children: [
      { "object.entity": { name: "Tag", children: [
        { "source.rdb": { "@table": "tags" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true, "@maxLength": 80 } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "Auth", "@discriminator": "type", children: [
        { "source.rdb": { "@table": "auths" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "type", "@values": ["Bridge", "Copay", "PriorAuth"] } },
        { "field.string": { name: "reference", "@required": true, "@maxLength": 80 } },
        // Declared on the BASE: legitimate for every row of the table.
        { "relationship.association": { name: "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "AuthTag" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "BridgeAuth", extends: "Auth", "@discriminatorValue": "Bridge", children: [
        { "field.int": { name: "quantity", "@required": true } },
        // Declared on a SUBTYPE, and a directed self-join onto that same subtype.
        { "relationship.association": { name: "linkedAuths", "@cardinality": "many", "@objectRef": "BridgeAuth", "@through": "AuthLink", "@sourceRefField": "fromAuthId" } },
      ]}},
      { "object.entity": { name: "CopayAuth", extends: "Auth", "@discriminatorValue": "Copay", children: [
        { "field.int": { name: "copayCents" } },
      ]}},
      // An ABSTRACT intermediate level that declares an M:N. It is neither the base nor
      // a concrete subtype, so it is the level an own-only filter loses entirely.
      { "object.entity": { name: "ScopedAuth", extends: "Auth", abstract: true, children: [
        { "relationship.association": { name: "auditors", "@cardinality": "many", "@objectRef": "Tag", "@through": "AuthAudit" } },
      ]}},
      { "object.entity": { name: "PriorAuthAuth", extends: "ScopedAuth", "@discriminatorValue": "PriorAuth", children: [
        { "field.string": { name: "approver", "@maxLength": 80 } },
      ]}},
      // The junction references the CONCRETE subtype, not the base. That is the supported
      // authoring, by a decision recorded in deriveM2MFields: the subject set is
      // {declaring entity, navigating entity}, and widening it to the whole super chain
      // would make its "must declare one identity.reference to ..." error unfalsifiable.
      // The physical FK is the same either way — a subtype stores into the base's table.
      { "object.entity": { name: "AuthAudit", children: [
        { "source.rdb": { "@table": "auth_audits" } },
        { "field.long": { name: "auditAuthId", "@required": true } },
        { "field.long": { name: "auditTagId", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": ["auditAuthId", "auditTagId"] } },
        { "identity.reference": { name: "fkAuditAuth", "@fields": "auditAuthId", "@references": "PriorAuthAuth" } },
        { "identity.reference": { name: "fkAuditTag", "@fields": "auditTagId", "@references": "Tag" } },
      ]}},
      { "object.entity": { name: "AuthTag", children: [
        { "source.rdb": { "@table": "auth_tags" } },
        { "field.long": { name: "authId", "@required": true } },
        { "field.long": { name: "tagId", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": ["authId", "tagId"] } },
        { "identity.reference": { name: "fkAuth", "@fields": "authId", "@references": "Auth" } },
        { "identity.reference": { name: "fkTag", "@fields": "tagId", "@references": "Tag" } },
      ]}},
      { "object.entity": { name: "AuthLink", children: [
        { "source.rdb": { "@table": "auth_links" } },
        { "field.long": { name: "fromAuthId", "@required": true } },
        { "field.long": { name: "toAuthId", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": ["fromAuthId", "toAuthId"] } },
        { "identity.reference": { name: "fkFrom", "@fields": "fromAuthId", "@references": "BridgeAuth" } },
        { "identity.reference": { name: "fkTo", "@fields": "toAuthId", "@references": "BridgeAuth" } },
      ]}},
      // A NON-subtype source whose M:N target IS a subtype.
      { "object.entity": { name: "Payer", children: [
        { "source.rdb": { "@table": "payers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true, "@maxLength": 80 } },
        { "relationship.association": { name: "bridgeAuths", "@cardinality": "many", "@objectRef": "BridgeAuth", "@through": "PayerAuth" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "PayerAuth", children: [
        { "source.rdb": { "@table": "payer_auths" } },
        { "field.long": { name: "payerId", "@required": true } },
        { "field.long": { name: "authId", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": ["payerId", "authId"] } },
        { "identity.reference": { name: "fkPayer", "@fields": "payerId", "@references": "Payer" } },
        { "identity.reference": { name: "fkAuth", "@fields": "authId", "@references": "BridgeAuth" } },
      ]}},
    ],
  },
};

async function loadModel(): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "tph-m2m-routes.json" }),
  ]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return result.root;
}

async function generate(root: MetaRoot): Promise<EmittedFile[]> {
  const renderContext = makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "./db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
    includeNames: true,
  });
  const gen = routesFile();
  const genCtx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: (e: MetaObject) => gen.filter?.(e) ?? true,
    projectRoot: "/x",
    config: { outDir: "/x", extStyle: "none", dbImport: "./db", dialect: "postgres" } as never,
    renderContext,
    warn: () => {},
  };
  return await gen.generate(genCtx);
}

/** An emitted file with its whitespace collapsed, so assertions survive the formatter. */
function fileNamed(files: EmittedFile[], path: string): string {
  const f = files.find((x) => x.path === path);
  if (f === undefined) throw new Error(`no emitted file ${path}; got ${files.map((x) => x.path).join(", ")}`);
  return f.content.replace(/\s+/g, " ");
}

/** One `mountM2mRoute({...})` call, selected by its relationName. */
function m2mMount(src: string, relationName: string): string {
  const m = new RegExp(`mountM2mRoute\\(\\{(?:(?!mountM2mRoute).)*?relationName: "${relationName}"(?:(?!mountM2mRoute).)*?\\}\\);`).exec(src);
  if (m === null) throw new Error(`no mountM2mRoute for "${relationName}" in: ${src.slice(0, 400)}`);
  return m[0];
}

describe("M:N traversal in a TPH hierarchy", () => {
  test("a base-declared M:N is mounted at the base path, with no source gate", async () => {
    const routes = fileNamed(await generate(await loadModel()), "Auth.routes.ts");
    const mount = m2mMount(routes, "tags");
    expect(mount).toContain("path: Auth.$path,");
    expect(mount).toContain("junctionTable: authTags,");
    expect(mount).toContain("targetTable: tags,");
    // Every row of `auths` is a legitimate source for a base-declared relationship.
    expect(mount).not.toContain("sourceDiscriminator");
    // The target is a plain entity, so no target filter either.
    expect(mount).not.toContain("targetDiscriminator");
  });

  test("a subtype-declared M:N hangs under the subtype segment and gates the source id", async () => {
    const routes = fileNamed(await generate(await loadModel()), "Auth.routes.ts");
    const mount = m2mMount(routes, "linkedAuths");
    expect(mount).toContain('path: Auth.$path + "/bridge",');
    expect(mount).toContain("junctionTable: authLinks,");
    // The self-join's target is the subtype, which stores into the base's table.
    expect(mount).toContain("targetTable: auths,");
    // Stage 0: the id must name a Bridge row, or the segment would be decorative.
    expect(mount).toMatch(
      /sourceDiscriminator: \{ table: auths, pkColumn: AuthNames\.fields\.id\.column, column: AuthNames\.fields\.type\.column, value: "Bridge",? \}/,
    );
    // Stage 2: the related rows are Bridge rows too (the target is the same subtype).
    expect(mount).toMatch(/targetDiscriminator: \{ column: AuthNames\.fields\.type\.column, value: "Bridge",? \}/);
  });

  test("an INHERITED M:N is served at the base AND under each subtype segment", async () => {
    const routes = fileNamed(await generate(await loadModel()), "Auth.routes.ts");
    // `tags` is declared on Auth, so every subtype resolves it. A subtype resource is a
    // resource: it carries the same sub-resources as any other. The overlap is not
    // redundancy — the subtype segment is a type assertion, and only the subtype mount
    // gates the source id, so /auths/bridge/{a Copay id}/tags is [] where /auths/{that
    // id}/tags is not. This is the independent oracle's rule (expectedRoutes), which
    // walks every SERVED object's RESOLVED relationships.
    const tagMounts = routes.match(/relationName: "tags"/g) ?? [];
    expect(tagMounts.length).toBe(4); // the base, plus /bridge, /copay and /priorauth
    const copayTags = m2mMount(routes.slice(routes.indexOf('Auth.$path + "/copay"')), "tags");
    expect(copayTags).toMatch(/sourceDiscriminator: \{ table: auths, pkColumn: \S+, column: \S+, value: "Copay",? \}/);
  });

  test("an M:N from a NON-subtype onto a subtype filters the target, not the source", async () => {
    const routes = fileNamed(await generate(await loadModel()), "Payer.routes.ts");
    const mount = m2mMount(routes, "bridgeAuths");
    expect(mount).toContain("path: Payer.$path,");
    // Binds to the base table — BridgeAuth exports no table const of its own.
    expect(mount).toContain("targetTable: auths,");
    expect(mount).toMatch(/targetDiscriminator: \{ column: AuthNames\.fields\.type\.column, value: "Bridge",? \}/);
    // The SOURCE is a plain entity: every payer row is a legitimate source.
    expect(mount).not.toContain("sourceDiscriminator");
  });

  test("an M:N declared on an ABSTRACT MID level mounts under each concrete subtype", async () => {
    const routes = fileNamed(await generate(await loadModel()), "Auth.routes.ts");
    // `auditors` lives on ScopedAuth — abstract, so it has no path and no rows of its
    // own. It is not on the base either, so the ONLY place it can be served is beneath
    // each concrete subtype under that level.
    const mount = m2mMount(routes, "auditors");
    expect(mount).toContain('path: Auth.$path + "/priorauth",');
    expect(mount).toContain("junctionTable: authAudits,");
    expect(mount).toContain("targetTable: tags,");
    expect(mount).toMatch(
      /sourceDiscriminator: \{ table: auths, pkColumn: AuthNames\.fields\.id\.column, column: AuthNames\.fields\.type\.column, value: "PriorAuth",? \}/,
    );
    // It is NOT mounted at the base path: Auth does not resolve `auditors`, and
    // ScopedAuth is abstract, so it is served nowhere else. Matches the oracle, whose
    // servedObjects() excludes abstract levels.
    expect(routes).not.toMatch(/path: Auth\.\$path, relationName: "auditors"/);
  });

  test("the polymorphic and per-subtype CRUD mounts are still emitted", async () => {
    const routes = fileNamed(await generate(await loadModel()), "Auth.routes.ts");
    expect(routes).toContain("mountCrudRoutes({ fastify: fastify, path: Auth.$path, db: db,");
    expect(routes).toContain('path: Auth.$path + "/bridge",');
    expect(routes).toContain('path: Auth.$path + "/copay",');
  });
});
