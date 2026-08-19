/**
 * Per-command scope (`migrate.scope`) — the expected-schema half.
 *
 * A consumer that owns one package tree's tables in a database another owner
 * also writes to declares `migrate": { "scope": [...] }`. Tables outside that
 * scope are neither created nor dropped, which takes TWO suppressions, not one:
 * dropping them from the EXPECTED side alone would turn every out-of-scope
 * table that exists in the database into a proposed DROP TABLE — the exact
 * hazard the feature exists to remove.
 *
 * The scope decision is made on the DECLARING OBJECT's fully-qualified name,
 * threaded out of the same Pass 1 walk that builds the tables (never re-derived
 * from a SQL name, which is lossy, and never a second walk, which would drift
 * from Pass 1's skip rules).
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, buildExpectedSchemaWithProvenance } from "../src/expected-schema.js";
import { scopeExpectedSchema, scopedDiffInputs } from "../src/scope.js";
import { diff } from "../src/diff/index.js";
import { planOffline } from "../src/snapshot/plan.js";
import { serializeSnapshot, SNAPSHOT_FORMAT_VERSION } from "../src/snapshot/serialize.js";
import type { SchemaSnapshot } from "../src/types.js";

const PLATFORM = JSON.stringify({
  "metadata.root": {
    package: "acme::platform",
    children: [
      {
        "object.entity": {
          name: "Job",
          children: [
            { "source.rdb": { name: "src", "@table": "jobs" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "title" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

const ARENA = JSON.stringify({
  "metadata.root": {
    package: "arena",
    children: [
      {
        "object.entity": {
          name: "Match",
          children: [
            { "source.rdb": { name: "src", "@table": "matches" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

async function loadBoth(): Promise<MetaRoot> {
  const loaded = await new MetaDataLoader().load([
    new InMemoryStringSource(PLATFORM),
    new InMemoryStringSource(ARENA),
  ]);
  return loaded.root;
}

/** The `migrate.scope: ["acme::platform::**"]` decision, without importing the
 *  pattern engine — migrate-ts takes a predicate precisely so it never carries a
 *  second implementation of one (`matchesScope` in the sdk is the only one). */
const platformOnly = (fqn: string): boolean => fqn.startsWith("acme::platform::");

describe("scopeExpectedSchema", () => {
  test("drops tables whose declaring object falls outside the scope", async () => {
    const root = await loadBoth();
    const built = buildExpectedSchemaWithProvenance(root, { dialect: "sqlite" });
    expect(built.snapshot.tables.map((t) => t.name).sort()).toEqual(["jobs", "matches"]);

    const scoped = scopeExpectedSchema(built, platformOnly);
    expect(scoped.snapshot.tables.map((t) => t.name)).toEqual(["jobs"]);
  });

  test("names the dropped tables so the ACTUAL side can be suppressed too", async () => {
    const root = await loadBoth();
    const scoped = scopeExpectedSchema(
      buildExpectedSchemaWithProvenance(root, { dialect: "sqlite" }),
      platformOnly,
    );
    // Qualified exactly as diff keys its tables (`<schema>.<name>`, schema
    // defaulting to the Postgres default), so the names feed `unmanagedNames`.
    expect(scoped.outOfScope).toEqual(["public.matches"]);
  });

  test("an undefined scope leaves the expected schema untouched", async () => {
    const root = await loadBoth();
    const built = buildExpectedSchemaWithProvenance(root, { dialect: "sqlite" });
    const scoped = scopeExpectedSchema(built, undefined);
    // Same object, not merely an equal one: an unscoped project must reach the
    // diff through byte-identical input.
    expect(scoped.snapshot).toBe(built.snapshot);
    expect(scoped.outOfScope).toEqual([]);
  });

  test("both sides: an out-of-scope table present in `actual` produces NO drop-table", async () => {
    const root = await loadBoth();
    const scoped = scopeExpectedSchema(
      buildExpectedSchemaWithProvenance(root, { dialect: "sqlite" }),
      platformOnly,
    );
    // The database holds BOTH tables — `matches` is another owner's, created by
    // another tool. It is absent from the scoped expected side.
    const actual: SchemaSnapshot = buildExpectedSchema(root, { dialect: "sqlite" });

    const result = await diff({
      expected: scoped.snapshot,
      actual,
      dialect: "sqlite",
      unmanagedNames: scoped.outOfScope,
    });
    expect(result.changes).toEqual([]);
  });

  test("without the actual-side suppression the same diff WOULD drop it (the hazard is real)", async () => {
    const root = await loadBoth();
    const scoped = scopeExpectedSchema(
      buildExpectedSchemaWithProvenance(root, { dialect: "sqlite" }),
      platformOnly,
    );
    const actual: SchemaSnapshot = buildExpectedSchema(root, { dialect: "sqlite" });

    const result = await diff({ expected: scoped.snapshot, actual, dialect: "sqlite" });
    expect(result.changes.map((c) => c.kind)).toEqual(["drop-table"]);
  });

  test("a table whose provenance is unknown is kept — scope never guesses", async () => {
    const root = await loadBoth();
    const built = buildExpectedSchemaWithProvenance(root, { dialect: "sqlite" });
    const withStranger: typeof built = {
      snapshot: {
        ...built.snapshot,
        tables: [
          ...built.snapshot.tables,
          { name: "stranger", columns: [], indexes: [], foreignKeys: [], checks: [], primaryKey: [] },
        ],
      },
      provenance: built.provenance,
    };
    const scoped = scopeExpectedSchema(withStranger, platformOnly);
    expect(scoped.snapshot.tables.map((t) => t.name)).toEqual(["jobs", "stranger"]);
    expect(scoped.outOfScope).toEqual(["public.matches"]);
  });
});

/**
 * A scope narrows which OBJECTS the run governs — never which SCHEMAS it may see.
 *
 * This is the consequence of pinning `scopeSchemas` to the UNSCOPED model, and it is
 * easy to read the other way round, so it is pinned here rather than left in a review
 * transcript. Excluding every declared object in a schema does NOT hand that schema
 * over: it stays in scope, so an UNDECLARED table sitting in it is still a drop
 * candidate — exactly as it would be on an unscoped run of the same model.
 *
 * The alternative (deriving the schema set from the survivors) reintroduces the
 * inversion the pin exists to close: a scope matching nothing empties `expected`,
 * `diff` reads that as "no model, govern the whole database", and every table in
 * every schema becomes a drop candidate. Narrowing must never widen.
 *
 * The way to stop managing a schema is to remove its objects from the MODEL, or to
 * declare them `@unmanaged` — both of which change what the model claims. A
 * `migrate.scope` says who runs the migration, not what the model describes.
 */
const REPORTING = JSON.stringify({
  "metadata.root": {
    package: "arena",
    children: [
      {
        "object.entity": {
          name: "Standing",
          children: [
            { "source.rdb": { name: "src", "@table": "standings", "@schema": "reporting" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

describe("scope narrows objects, never schemas", () => {
  test("a schema whose every declared object is excluded STAYS in scope", async () => {
    const loaded = await new MetaDataLoader().load([
      new InMemoryStringSource(PLATFORM),
      new InMemoryStringSource(REPORTING),
    ]);
    const built = buildExpectedSchemaWithProvenance(loaded.root, { dialect: "postgres" });
    const scoped = scopeExpectedSchema(built, platformOnly);

    // `reporting` lost its only declared object, and is still pinned.
    expect(scoped.snapshot.tables.map((t) => t.name)).toEqual(["jobs"]);
    expect(scoped.declaredSchemas).toEqual(["public", "reporting"]);

    // A table nobody declared, living in that schema. It has no provenance, so it
    // never reaches `outOfScope` and nothing suppresses it on the actual side.
    const actual: SchemaSnapshot = {
      tables: [
        ...built.snapshot.tables,
        { name: "legacy_stats", schema: "reporting", columns: [], indexes: [], foreignKeys: [], checks: [], primaryKey: [] },
      ],
      views: [],
    };
    const result = await diff({
      ...scopedDiffInputs(scoped, []),
      actual,
      dialect: "postgres",
      allow: { dropTable: true },
    });

    // It IS a drop candidate — the same verdict an unscoped run of this model gives.
    const drops = result.changes.filter((c) => c.kind === "drop-table");
    expect(drops).toHaveLength(1);
    if (drops[0]?.kind !== "drop-table") throw new Error("expected a drop-table");
    expect(drops[0].table).toBe("legacy_stats");
  });

  test("a schema the model never declares at all is untouched (the pin is not a widening)", async () => {
    const loaded = await new MetaDataLoader().load([
      new InMemoryStringSource(PLATFORM),
      new InMemoryStringSource(REPORTING),
    ]);
    const built = buildExpectedSchemaWithProvenance(loaded.root, { dialect: "postgres" });
    const scoped = scopeExpectedSchema(built, platformOnly);

    const actual: SchemaSnapshot = {
      tables: [
        ...built.snapshot.tables,
        { name: "events", schema: "analytics", columns: [], indexes: [], foreignKeys: [], checks: [], primaryKey: [] },
      ],
      views: [],
    };
    const result = await diff({
      ...scopedDiffInputs(scoped, []),
      actual,
      dialect: "postgres",
      allow: { dropTable: true },
    });
    expect(result.changes).toEqual([]);
  });
});

describe("an accepted scoped run keeps out-of-scope entries in the committed snapshot", () => {
  test("the snapshot planOffline hands back retains the excluded table", async () => {
    const root = await loadBoth();
    const prior = buildExpectedSchema(root, { dialect: "sqlite" });
    expect(prior.tables.map((t) => t.name).sort()).toEqual(["jobs", "matches"]);

    const plan = await planOffline({
      metadata: root,
      dialect: "sqlite",
      snapshot: prior,
      inScope: platformOnly,
    });

    // The DIFF side is narrowed — the run governs `jobs` only...
    expect(plan.expected.tables.map((t) => t.name)).toEqual(["jobs"]);
    // ...but the snapshot it commits still holds `matches`. Committing the narrowed
    // schema would delete it, and removing `migrate.scope` later would then propose
    // CREATE TABLE for a table that exists — a migration that fails at apply.
    expect(plan.nextSnapshot.tables.map((t) => t.name).sort()).toEqual(["jobs", "matches"]);
  });

  test("an unscoped run commits the SAME object — byte-identical snapshot", async () => {
    const root = await loadBoth();
    const prior = buildExpectedSchema(root, { dialect: "sqlite" });
    const plan = await planOffline({ metadata: root, dialect: "sqlite", snapshot: prior });
    expect(plan.nextSnapshot).toBe(plan.expected);
  });

  test("removing the scope after an accepted run proposes nothing (the round trip)", async () => {
    const root = await loadBoth();
    const prior = buildExpectedSchema(root, { dialect: "sqlite" });

    const scopedRun = await planOffline({
      metadata: root, dialect: "sqlite", snapshot: prior, inScope: platformOnly,
    });
    // Second run, scope removed, diffing against what the first run committed.
    const unscopedRun = await planOffline({
      metadata: root, dialect: "sqlite", snapshot: scopedRun.nextSnapshot,
    });
    expect(unscopedRun.diff.changes).toEqual([]);
  });
});

describe("provenance never reaches the committed snapshot", () => {
  test("a view's declaring FQN is recorded but never serialized; formatVersion stays 3", async () => {
    const root = await loadBoth();
    const view = { name: "v_jobs", sql: "SELECT id FROM jobs", dependsOn: ["jobs"] };

    const withFqn = buildExpectedSchemaWithProvenance(root, {
      dialect: "sqlite",
      views: [{ ...view, fqn: "acme::platform::JobSummary" }],
    });
    const withoutFqn = buildExpectedSchema(root, { dialect: "sqlite", views: [view] });

    // The provenance thread is invisible on disk: carrying it changes no bytes.
    expect(serializeSnapshot(withFqn.snapshot)).toBe(serializeSnapshot(withoutFqn));
    expect(serializeSnapshot(withFqn.snapshot)).not.toContain("fqn");
    expect(SNAPSHOT_FORMAT_VERSION).toBe(3);

    // ...and it IS recorded, keyed like every other qualified name.
    expect(withFqn.provenance.get("public.v_jobs")).toBe("acme::platform::JobSummary");
  });

  test("a table's provenance is its declaring entity's resolutionKey()", async () => {
    const root = await loadBoth();
    const { provenance } = buildExpectedSchemaWithProvenance(root, { dialect: "sqlite" });
    expect(provenance.get("public.jobs")).toBe("acme::platform::Job");
    expect(provenance.get("public.matches")).toBe("arena::Match");
  });
});
