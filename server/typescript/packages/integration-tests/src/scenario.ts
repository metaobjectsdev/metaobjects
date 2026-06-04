// Scenario types + YAML loader for the persistence-conformance corpus.
// Same fixture format the C# runner consumes; this file is the TS-side parser.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { load as yamlLoad } from "js-yaml";

export interface MigrationScenario {
  readonly kind: "migration";
  readonly name: string;
  readonly description: string;
  readonly sourcePath: string;
  readonly seedMetadataDir: string | null;
  readonly seedData: string | null;
  readonly targetMetadataDir: string | null;
  readonly targetMetadataInline: string | null;
  readonly expect: MigrationExpect;
}

export interface MigrationExpect {
  readonly blocked: ReadonlyArray<{ kind: string; reasonContains: string }>;
  readonly upContains: ReadonlyArray<string>;
  readonly upEmpty: boolean | null;
  readonly applyUpThenQuery: { sql: string; rows: ReadonlyArray<Record<string, unknown>> } | null;
}

export interface QueryScenario {
  readonly kind: "query";
  readonly name: string;
  readonly description: string;
  readonly sourcePath: string;
  readonly seedData: string | null;
  readonly queries: ReadonlyArray<QuerySpec>;
}

export interface QuerySpec {
  readonly name: string;
  readonly op: "list" | "get" | "count" | "relate" | "create" | "update" | "delete" | "roundtrip";
  readonly entity: string;
  readonly by: Record<string, unknown> | null;
  /**
   * For `op: create` / `op: update`: the row payload to write. On a TPH subtype
   * the discriminator is injected by the runtime (omit it). `op: update` also
   * requires `by: { id }`. `op: delete` requires only `by: { id }` (no `data`);
   * its `expect` is the boolean delete outcome (true = a row was deleted).
   */
  readonly data: Record<string, unknown> | null;
  /**
   * When true the op is expected to FAIL (throw/reject) — e.g. a TPH
   * cross-subtype write (unknown subtype column, or a different-subtype id).
   * The result `expect` is ignored. Portable across ports: each runner asserts
   * "the op raised an error", not a specific message.
   */
  readonly expectError: boolean;
  /**
   * For `op: relate`: the relationship name to traverse from the `by` source
   * record (e.g. an M:N navigation). The result is the related rows.
   */
  readonly relation: string | null;
  /**
   * For `op: roundtrip`: the field-keyed row to INSERT via the port's runtime
   * write path. The runner inserts it, reads the inserted row back by PK, then
   * asserts the normalized read-back equals `expect`. This exercises the WRITE
   * codec + the read path together (the structural complement to the read gate).
   * Values are the native authoring forms the runtime accepts on write (e.g. a
   * decimal as a string, a uuid as a string, a jsonb `field.object` as an
   * object); `expect` is the wire-normalized read-back form.
   */
  readonly insert: Record<string, unknown> | null;
  /**
   * Either `{ field: { op: value } }` (each top-level key is a field name) or
   * `{ and: [filter, filter, ...] }` (compose by AND). Mixed forms are
   * ill-formed — pick one at each level.
   */
  readonly filter: Record<string, unknown> | null;
  readonly sort: ReadonlyArray<{ field: string; dir: "asc" | "desc" }> | null;
  readonly limit: number | null;
  readonly offset: number | null;
  readonly expect: unknown;
}

// ---------- public API ----------

export function loadMigrations(dir: string): MigrationScenario[] {
  return listYaml(dir).map(loadMigration);
}

export function loadQueries(dir: string): QueryScenario[] {
  return listYaml(dir).map(loadQuery);
}

export function loadMigration(yamlPath: string): MigrationScenario {
  const raw = yamlLoad(readFileSync(yamlPath, "utf8")) as MigrationYaml;
  const base = dirname(yamlPath);
  return {
    kind: "migration",
    name: required(raw.name, yamlPath, "name"),
    description: raw.description ?? "",
    sourcePath: yamlPath,
    seedMetadataDir: resolveRel(base, raw["seed-metadata"]),
    seedData: raw["seed-data"] ?? null,
    targetMetadataDir: resolveRel(base, raw["target-metadata"]),
    targetMetadataInline: raw["target-metadata-inline"] ?? null,
    expect: {
      blocked: (raw.expect?.blocked ?? []).map((b) => ({
        kind: b.kind ?? "",
        reasonContains: b["reason-contains"] ?? "",
      })),
      upContains: raw.expect?.["up-contains"] ?? [],
      upEmpty: raw.expect?.["up-empty"] ?? null,
      applyUpThenQuery: raw.expect?.["apply-up-then-query"]
        ? {
            sql: raw.expect["apply-up-then-query"].sql ?? "",
            rows: raw.expect["apply-up-then-query"].rows ?? [],
          }
        : null,
    },
  };
}

export function loadQuery(yamlPath: string): QueryScenario {
  const raw = yamlLoad(readFileSync(yamlPath, "utf8")) as QueryYaml;
  return {
    kind: "query",
    name: required(raw.name, yamlPath, "name"),
    description: raw.description ?? "",
    sourcePath: yamlPath,
    seedData: raw["seed-data"] ?? null,
    queries: (raw.queries ?? []).map((q) => ({
      name: required(q.name, yamlPath, "query.name"),
      op: required(q.op, yamlPath, "query.op") as QuerySpec["op"],
      entity: required(q.entity, yamlPath, "query.entity"),
      by: (q.by as Record<string, unknown> | undefined) ?? null,
      data: (q.data as Record<string, unknown> | undefined) ?? null,
      expectError: q.expectError === true,
      relation: q.relation ?? null,
      insert: (q.insert as Record<string, unknown> | undefined) ?? null,
      filter: (q.filter as Record<string, unknown> | undefined) ?? null,
      sort: q.sort
        ? q.sort.map((s) => ({ field: s.field ?? "", dir: (s.dir as "asc" | "desc") ?? "asc" }))
        : null,
      limit: q.limit ?? null,
      offset: q.offset ?? null,
      expect: q.expect,
    })),
  };
}

// ---------- helpers ----------

function listYaml(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => join(dir, f));
}

function required<T>(value: T | undefined | null, path: string, field: string): T {
  if (value === undefined || value === null) throw new Error(`${path}: missing '${field}'`);
  return value;
}

function resolveRel(base: string, rel: string | undefined | null): string | null {
  return rel ? resolve(base, rel) : null;
}

// ---------- YAML wire shapes (hyphenated keys per the fixture format) ----------

interface MigrationYaml {
  name?: string;
  description?: string;
  "seed-metadata"?: string;
  "seed-data"?: string;
  "target-metadata"?: string;
  "target-metadata-inline"?: string;
  expect?: {
    blocked?: { kind?: string; "reason-contains"?: string }[];
    "up-contains"?: string[];
    "up-empty"?: boolean;
    "apply-up-then-query"?: { sql?: string; rows?: Record<string, unknown>[] };
  };
}

interface QueryYaml {
  name?: string;
  description?: string;
  "seed-data"?: string;
  queries?: {
    name?: string;
    op?: string;
    entity?: string;
    by?: unknown;
    data?: unknown;
    expectError?: boolean;
    relation?: string;
    insert?: unknown;
    filter?: unknown;
    sort?: { field?: string; dir?: string }[];
    limit?: number;
    offset?: number;
    expect?: unknown;
  }[];
}
