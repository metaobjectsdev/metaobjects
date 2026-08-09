// `timestampMode: "date"` — EXECUTION pins (post-#281 pre-publish review).
//
// Every #281 test asserted on emitted SOURCE TEXT; none executed a generated
// schema. This repo has a named precedent for exactly that failure mode
// (0.20.6: `z.string().ip()` — a Zod-4 removal that hid until a test actually
// ran the schema against real Zod). These tests write the REAL rendered
// output to a temp `.ts` file INSIDE this package (so a bare `"zod"` /
// `"drizzle-orm/*"` import resolves through the workspace's node_modules) and
// dynamically `import()` it, then call the real `safeParse`/`parse` on the
// real Zod object it exports — not a string match.
//
// Covers the three Criticals + Important 5 found by that review, plus a
// codegen-time WARNING for Important 4 (added on top after the initial fix
// was reviewed clean — a cheap generation-time detect for the one runtime gap
// left documented-not-fixed: filtering a date-mode timestamp throws at
// request time; see runGen's warning + filter-parser.ts's limitation note):
//   CRITICAL 1 — z.date() rejects every JSON wire value; fix is z.coerce.date().
//   CRITICAL 2 — sqlite/D1 + date mode used to emit non-compiling code (a
//                regression #281 itself introduced); fix normalizes the mode
//                to "string" for dialect:"sqlite" at the config choke points.
//   CRITICAL 3 — a projection/write-through view's read schema (zodTypeFor,
//                via view-decl.ts) was a fifth timestamp-Zod emitter #281's
//                sweep missed and still hardcoded z.string().
//   IMPORTANT 5 — a VO-hosted (object.value) timestamp must stay z.string()
//                even in date mode: VO storage is inherently ISO-string jsonb.
//   IMPORTANT 4 — a @filterable timestamp field under date mode warns once at
//                `runGen` time (detect, don't fix the runtime threading —
//                repo precedent: #226/#258 detect-and-refuse at gen time).

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MetaDataLoader, InMemoryStringSource,
  TypeId, TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY,
  OBJECT_SUBTYPE_ENTITY, OBJECT_SUBTYPE_VALUE,
  FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_TIMESTAMP,
} from "@metaobjectsdev/metadata";
import { meta, metaObject, metaField, metaRoot } from "./_meta-build.js";
import { renderZodValidators, renderInsertSchemaOnly } from "../src/templates/zod-validators.js";
import { renderProjectionDecl } from "../src/templates/projection-decl.js";
import { makeRenderContext } from "../src/render-context.js";
import { normalizeConfig, defineConfig } from "../src/metaobjects-config.js";
import { runGen } from "../src/runner.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";

// biome-ignore lint/suspicious/noExplicitAny: dynamically imported generated module — no static shape
type GeneratedModule = Record<string, any>;

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

/**
 * Write `source` (a full rendered file, imports included — ts-poet's
 * `Code.toString()` already hoists them) to a temp `.ts` file INSIDE this
 * package (`import.meta.dir`) so bare-specifier imports resolve through the
 * workspace's node_modules, then dynamically import it. This is REAL
 * execution of the generated code — not a text match against the source.
 */
async function executeGenerated(source: string): Promise<GeneratedModule> {
  const dir = mkdtempSync(join(import.meta.dir, "tmp-ts-mode-exec-"));
  tmpDirs.push(dir);
  const file = join(dir, "schema.ts");
  writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

function makePost(): ReturnType<typeof metaObject> {
  const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
  post.addChild(metaField(FIELD_SUBTYPE_LONG, "id"));
  post.addChild(metaField(FIELD_SUBTYPE_TIMESTAMP, "updatedAt")); // plain, non-required, non-autoSet
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  post.addChild(primary);
  return post;
}

describe('timestampMode: "date" — execution pins', () => {
  test("CRITICAL 1: InsertSchema.safeParse accepts a JSON wire ISO string (z.date() rejects it outright)", async () => {
    const post = makePost();
    const root = metaRoot();
    root.addChild(post);
    const ctx = makeRenderContext({
      dialect: "postgres", timestampMode: "date", loadedRoot: root,
      outDir: "/x", dbImport: "~/db", pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const mod = await executeGenerated(renderZodValidators(post, ctx).toString());

    // The exact failure mode this fixes: z.date().safeParse(isoString) is false.
    const ok = mod.PostInsertSchema.safeParse({ updatedAt: "2026-08-08T10:00:00.000Z" });
    expect(ok.success).toBe(true);
    expect(ok.data.updatedAt instanceof Date).toBe(true);
    expect(ok.data.updatedAt.toISOString()).toBe("2026-08-08T10:00:00.000Z");

    // Not a rubber stamp — a genuinely invalid value still fails.
    const bad = mod.PostInsertSchema.safeParse({ updatedAt: "not-a-date" });
    expect(bad.success).toBe(false);

    // FR-035 present-null clearing must survive the coerce switch: a present
    // `null` still short-circuits through `.nullable()` on the UpdateSchema.
    const cleared = mod.PostUpdateSchema.safeParse({ updatedAt: null });
    expect(cleared.success).toBe(true);
    expect(cleared.data.updatedAt).toBeNull();
  });

  test('CRITICAL 2: dialect:"sqlite" normalizes timestampMode to "string" at both config choke points, end to end', async () => {
    // Function-level pin: normalizeConfig (the `meta gen` entry point).
    const normalized = normalizeConfig(defineConfig({
      outDir: "out", extStyle: "none", dbImport: "../db", dialect: "sqlite",
      timestampMode: "date", generators: [],
    }));
    expect(normalized.timestampMode).toBe("string");
    // Postgres is genuinely unaffected by the same normalization.
    const pgNormalized = normalizeConfig(defineConfig({
      outDir: "out", extStyle: "none", dbImport: "../db", dialect: "postgres",
      timestampMode: "date", generators: [],
    }));
    expect(pgNormalized.timestampMode).toBe("date");

    // Function-level pin: makeRenderContext (the OTHER choke point — a bare
    // template-unit-test / generator call outside `runGen`).
    const post = makePost();
    const root = metaRoot();
    root.addChild(post);
    const ctx = makeRenderContext({
      dialect: "sqlite", timestampMode: "date", loadedRoot: root,
      outDir: "/x", dbImport: "~/db", pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    expect(ctx.timestampMode).toBe("string");

    // End-to-end: the sqlite+date combination must not silently produce broken
    // output (#281's regression) — execute the resulting schema and confirm
    // the field stays a plain STRING (not coerced to Date), proving the mode
    // really normalized rather than merely that z.coerce.date() also accepts
    // a string.
    const mod = await executeGenerated(renderZodValidators(post, ctx).toString());
    const ok = mod.PostInsertSchema.safeParse({ updatedAt: "2026-08-08T10:00:00.000Z" });
    expect(ok.success).toBe(true);
    expect(typeof ok.data.updatedAt).toBe("string");
  });

  test("CRITICAL 3: a projection's view read schema executes against a DB-row Date (the fifth timestamp-Zod emitter #281's sweep missed)", async () => {
    const json = JSON.stringify({
      "metadata.root": {
        package: "test",
        children: [
          { "object.entity": { name: "Cfg", children: [
            { "source.rdb": { "@table": "cfgs" } },
            { "field.uuid": { name: "id" } },
            { "field.timestamp": { name: "createdAt" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ] } },
          { "object.projection": { name: "CfgView", children: [
            { "source.rdb": { "@kind": "view", "@table": "v_cfg" } },
            { "field.uuid": { name: "id", extends: "Cfg.id" } },
            { "field.timestamp": { name: "created_at",
              children: [{ "origin.passthrough": { "@from": "Cfg.createdAt" } }] } },
            { "identity.primary": { name: "id", extends: "Cfg.id" } },
          ] } },
        ],
      },
    });
    const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    expect(result.errors).toEqual([]);
    const projection = result.root.objects().find((o) => o.name === "CfgView")!;

    const code = renderProjectionDecl(projection, result.root, {
      columnNamingStrategy: "snake_case", dialect: "postgres", timestampMode: "date", allowlists: false,
    });
    const mod = await executeGenerated(code);

    // Before this fix: zodTypeFor hardcoded z.string() here regardless of mode —
    // a "date"-mode view column (Date-typed, mapColumnType honors the mode) fed
    // through a z.string() read schema would reject the real DB-driver-returned
    // Date at runtime.
    const row = mod.CfgViewSchema.safeParse({
      id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      created_at: new Date("2026-08-08T10:00:00.000Z"),
    });
    expect(row.success).toBe(true);
    expect(row.data.created_at instanceof Date).toBe(true);
  });

  test("IMPORTANT 5: a value-object-hosted timestamp stays z.string() even in date mode (VO storage is jsonb, always string)", async () => {
    const note = metaObject(OBJECT_SUBTYPE_VALUE, "Note");
    note.addChild(metaField(FIELD_SUBTYPE_TIMESTAMP, "loggedAt"));
    const root = metaRoot();
    root.addChild(note);
    const ctx = makeRenderContext({
      dialect: "postgres", timestampMode: "date", loadedRoot: root,
      outDir: "/x", dbImport: "~/db", pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const mod = await executeGenerated(renderInsertSchemaOnly(note, ctx).toString());

    const ok = mod.NoteInsertSchema.safeParse({ loggedAt: "2026-08-08T10:00:00.000Z" });
    expect(ok.success).toBe(true);
    // NOT coerced to Date — the VO structural interface (inferred-types.ts's
    // SCALAR_TS_BY_SUBTYPE, deliberately not mode-aware) and this Zod schema
    // must agree (documented lock-step), and VO jsonb storage is always string.
    expect(typeof ok.data.loggedAt).toBe("string");
    expect(ok.data.loggedAt).toBe("2026-08-08T10:00:00.000Z");
  });
});

describe('IMPORTANT 4: runGen warns (once) when timestampMode: "date" meets a @filterable timestamp field', () => {
  // Two entities, each with a @filterable timestamp field PLUS a non-filterable
  // timestamp field — proves the warning is field-selective (only @filterable
  // fields are named) and fires ONCE for the whole run (not once per field or
  // per entity), naming every offender in that one line.
  const TWO_FILTERABLE_TIMESTAMPS = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        { "object.entity": { name: "Post", children: [
          { "source.rdb": { "@table": "posts" } },
          { "field.long": { name: "id" } },
          { "field.timestamp": { name: "updatedAt", "@filterable": true } },
          { "field.timestamp": { name: "archivedAt" } }, // NOT filterable — must not be named
          { "identity.primary": { name: "primary", "@fields": ["id"], "@generation": "increment" } },
        ] } },
        { "object.entity": { name: "Comment", children: [
          { "source.rdb": { "@table": "comments" } },
          { "field.long": { name: "id" } },
          { "field.timestamp": { name: "postedAt", "@filterable": true } },
          { "identity.primary": { name: "primary", "@fields": ["id"], "@generation": "increment" } },
        ] } },
      ],
    },
  });

  const NO_FILTERABLE_TIMESTAMP = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        { "object.entity": { name: "Post", children: [
          { "source.rdb": { "@table": "posts" } },
          { "field.long": { name: "id" } },
          { "field.timestamp": { name: "updatedAt" } }, // present, but NOT filterable
          { "field.string": { name: "title", "@filterable": true } }, // filterable, but not a timestamp
          { "identity.primary": { name: "primary", "@fields": ["id"], "@generation": "increment" } },
        ] } },
      ],
    },
  });

  async function runWithMetadata(json: string, dialect: "postgres" | "sqlite", timestampMode?: "date" | "string") {
    const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    expect(result.errors).toEqual([]);
    const dir = mkdtempSync(join(tmpdir(), "codegen-runner-important4-"));
    try {
      return await runGen({
        config: defineConfig({
          outDir: dir, extStyle: "none", dbImport: "../db", dialect,
          ...(timestampMode !== undefined && { timestampMode }),
          generators: [],
        }),
        metadata: result.root,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('warns exactly once, naming every offending entity+field, when dialect:"postgres" + timestampMode:"date"', async () => {
    const { warnings } = await runWithMetadata(TWO_FILTERABLE_TIMESTAMPS, "postgres", "date");
    const hits = warnings.filter((w) => w.includes('timestampMode: "date"'));
    expect(hits.length).toBe(1); // once per run, not once per field/entity
    expect(hits[0]).toContain("Post.updatedAt");
    expect(hits[0]).toContain("Comment.postedAt");
    expect(hits[0]).not.toContain("archivedAt"); // non-filterable — not named
  });

  test('silent in the default "string" mode (timestampMode omitted)', async () => {
    const { warnings } = await runWithMetadata(TWO_FILTERABLE_TIMESTAMPS, "postgres");
    expect(warnings.filter((w) => w.includes('timestampMode: "date"'))).toEqual([]);
  });

  test('silent when no field is both @filterable and a timestamp, even in date mode', async () => {
    const { warnings } = await runWithMetadata(NO_FILTERABLE_TIMESTAMP, "postgres", "date");
    expect(warnings.filter((w) => w.includes('timestampMode: "date"'))).toEqual([]);
  });

  test('silent under dialect:"sqlite" — timestampMode normalizes to "string" (Critical 2), so Important 4 never fires', async () => {
    const { warnings } = await runWithMetadata(TWO_FILTERABLE_TIMESTAMPS, "sqlite", "date");
    expect(warnings.filter((w) => w.includes('timestampMode: "date"'))).toEqual([]);
  });
});
