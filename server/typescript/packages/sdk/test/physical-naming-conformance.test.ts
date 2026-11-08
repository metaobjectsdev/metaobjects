// ADR-0058 — the cross-port physical-naming corpus, run through TypeScript's own config reader
// and resolvers: the `naming` block parses with the schema `.metaobjects/config.json` is read
// with, the loaded root carries it, and every table and column resolves through the same
// functions codegen, `meta migrate` and the ObjectManager call.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileSource } from "@metaobjectsdev/metadata/core";
import {
  MetaDataLoader,
  isMetaRoot,
  isMetaObject,
  refTarget,
  resolveColumnName,
  resolveFlattenedColumnName,
  resolveTableName,
  FIELD_ATTR_OBJECT_REF,
  columnNamingStrategy,
  tableNamingRule,
  registerColumnNamingStrategy,
  registerTableNamingRule,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { ConfigSchema, physicalNamingFromConfig } from "../src/config.js";
import { loadMemory } from "../src/memory.js";

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/naming-conformance/physical-names");

interface NamingCase {
  name: string;
  naming: unknown;
  tables: Record<string, string>;
  columns: Record<string, string>;
}
interface AppStrategy {
  name: string;
  for: "columns" | "tables";
  delegate: string;
  upperCase?: string[];
  prefix?: string;
}
const corpus = JSON.parse(readFileSync(join(CORPUS, "cases.json"), "utf8")) as {
  strategies: AppStrategy[];
  cases: NamingCase[];
  invalid: { name: string; naming: unknown; messageIncludes?: string[] }[];
};

// The corpus's application-registered strategies, registered the way an application does:
// through the registry, each delegating to a built-in it looks up by name.
for (const s of corpus.strategies) {
  const delegate = s.for === "columns" ? columnNamingStrategy(s.delegate) : tableNamingRule(s.delegate);
  const upper = new Set(s.upperCase ?? []);
  const apply = (n: string): string => (upper.has(n) ? n.toUpperCase() : (s.prefix ?? "") + delegate(n));
  if (s.for === "columns") registerColumnNamingStrategy(s.name, apply);
  else registerTableNamingRule(s.name, apply);
}

/** The config file a project would carry for this case. */
function configFor(naming: unknown): Record<string, unknown> {
  return naming === null ? { schema_version: 1 } : { schema_version: 1, naming };
}

async function loadCorpusModel(): Promise<MetaRoot> {
  const result = await new MetaDataLoader().load([new FileSource(join(CORPUS, "meta.naming.json"))]);
  expect(result.errors).toEqual([]);
  if (!isMetaRoot(result.root)) throw new Error("not a root");
  return result.root;
}

function assertNames(root: MetaRoot, c: NamingCase): void {
  const tables: Record<string, string> = {};
  for (const name of Object.keys(c.tables)) tables[name] = resolveTableName(root.findObject(name)!);
  expect(tables).toEqual(c.tables);
  const columns: Record<string, string> = {};
  for (const key of Object.keys(c.columns)) {
    const [objectName, fieldName, memberName] = key.split(".") as [string, string, string | undefined];
    const field = root.findObject(objectName)!.fields().find((f) => f.name === fieldName)!;
    if (memberName === undefined) {
      columns[key] = resolveColumnName(field);
      continue;
    }
    // `<Object>.<field>.<member>`: a member of the flattened value object the field embeds.
    const target = refTarget(field, FIELD_ATTR_OBJECT_REF);
    if (target === undefined || !isMetaObject(target)) throw new Error(`${key}: @objectRef does not resolve`);
    const member = target.fields().find((f) => f.name === memberName)!;
    columns[key] = resolveFlattenedColumnName(field, member);
  }
  expect(columns).toEqual(c.columns);
}

describe("physical-naming conformance (ADR-0058)", () => {
  for (const c of corpus.cases) {
    test(`${c.name}: every table and column resolves through the root's rules`, async () => {
      const root = await loadCorpusModel();
      root.physicalNaming = physicalNamingFromConfig(ConfigSchema.parse(configFor(c.naming)));
      assertNames(root, c);
    });
  }

  for (const c of corpus.invalid) {
    test(`${c.name}: the config is refused when read`, () => {
      const parsed = ConfigSchema.safeParse(configFor(c.naming));
      expect(parsed.success).toBe(false);
      if (c.messageIncludes !== undefined && !parsed.success) {
        const message = parsed.error.issues.map((i) => i.message).join("\n");
        for (const part of c.messageIncludes) expect(message).toContain(part);
        expect(message).toContain("TypeScript port");
      }
    });
  }

  test("the project-aware load sets the root from .metaobjects/config.json", async () => {
    const literalTables = corpus.cases.find((c) => c.name === "kebab-case columns, literal tables")!;
    const dir = mkdtempSync(join(tmpdir(), "mo-naming-"));
    try {
      mkdirSync(join(dir, ".metaobjects"));
      mkdirSync(join(dir, "metaobjects"));
      writeFileSync(join(dir, ".metaobjects", "config.json"), JSON.stringify(configFor(literalTables.naming)));
      copyFileSync(join(CORPUS, "meta.naming.json"), join(dir, "metaobjects", "meta.naming.json"));
      const root = await loadMemory(dir);
      expect(root.physicalNaming).toEqual({ columns: "kebab-case", tables: "literal" });
      assertNames(root, literalTables);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a project with no naming block loads with the snake_case defaults", async () => {
    const defaults = corpus.cases.find((c) => c.name === "default")!;
    const dir = mkdtempSync(join(tmpdir(), "mo-naming-"));
    try {
      mkdirSync(join(dir, ".metaobjects"));
      mkdirSync(join(dir, "metaobjects"));
      writeFileSync(join(dir, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1 }));
      copyFileSync(join(CORPUS, "meta.naming.json"), join(dir, "metaobjects", "meta.naming.json"));
      const root = await loadMemory(dir);
      expect(root.physicalNaming).toEqual({ columns: "snake_case", tables: "snake_case" });
      assertNames(root, defaults);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
