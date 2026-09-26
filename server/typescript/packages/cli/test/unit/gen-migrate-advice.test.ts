// `meta gen`'s "now migrate" next step: in the project's own dialect, and only when the
// run can have changed the database schema.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, snapshotPath, writeSnapshot } from "@metaobjectsdev/migrate-ts";
import { genMigrateAdvice, type GenMigrateAdviceInput } from "../../src/lib/gen-migrate-advice.js";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const OUT_DIR = "./.metaobjects/migrations";

function project(): string {
  const d = mkdtempSync(join(tmpdir(), "gen-migrate-advice-"));
  dirs.push(d);
  return d;
}

const PET = {
  "object.entity": {
    name: "Pet",
    children: [
      { "source.rdb": { "@table": "pets" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "name" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ],
  },
};
const PAYLOAD = {
  "object.value": { name: "TriagePayload", children: [{ "field.string": { name: "complaint" } }] },
};

async function load(children: unknown[]): Promise<MetaRoot> {
  const r = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "clinic", children } })),
  ]);
  expect(r.errors).toEqual([]);
  return r.root;
}

function input(over: Partial<GenMigrateAdviceInput> & Pick<GenMigrateAdviceInput, "metadata" | "projectRoot">): GenMigrateAdviceInput {
  return {
    dialect: "sqlite",
    migrateDialect: undefined,
    columnNamingStrategy: undefined,
    migrateOutDir: OUT_DIR,
    changedFiles: ["src/generated/Pet.ts"],
    ...over,
  };
}

describe("genMigrateAdvice", () => {
  test("a model with no table-backed object gets no migrate advice", async () => {
    const metadata = await load([PAYLOAD]);
    expect(await genMigrateAdvice(input({ metadata, projectRoot: project(), changedFiles: ["src/generated/TriagePayload.ts"] })))
      .toBeUndefined();
  });

  test("nothing written this run → no advice", async () => {
    const metadata = await load([PET]);
    expect(await genMigrateAdvice(input({ metadata, projectRoot: project(), changedFiles: [] }))).toBeUndefined();
  });

  test("no snapshot yet: an entity file changed → greenfield advice in the CONFIGURED dialect", async () => {
    const metadata = await load([PET]);
    const advice = await genMigrateAdvice(input({ metadata, projectRoot: project(), dialect: "postgres" }));
    expect(advice).toContain("--dialect postgres");
    expect(advice).not.toContain("<sqlite|postgres>");
  });

  test("committed snapshot equal to the expected schema → no advice (a value-only change)", async () => {
    const metadata = await load([PET, PAYLOAD]);
    const root = project();
    const snap = snapshotPath(join(root, OUT_DIR), "sqlite");
    mkdirSync(join(root, OUT_DIR), { recursive: true });
    await writeSnapshot(snap, buildExpectedSchema(metadata, { dialect: "sqlite" }));
    expect(await genMigrateAdvice(input({ metadata, projectRoot: root, changedFiles: ["src/generated/TriagePayload.ts", "src/generated/Pet.ts"] })))
      .toBeUndefined();
  });

  test("committed snapshot BEHIND the metadata → advice to migrate the change", async () => {
    const root = project();
    mkdirSync(join(root, OUT_DIR), { recursive: true });
    await writeSnapshot(snapshotPath(join(root, OUT_DIR), "sqlite"), buildExpectedSchema(await load([PET]), { dialect: "sqlite" }));
    const grown = await load([{
      "object.entity": {
        ...PET["object.entity"],
        children: [...PET["object.entity"].children, { "field.string": { name: "microchip" } }],
      },
    }]);
    const advice = await genMigrateAdvice(input({ metadata: grown, projectRoot: root }));
    expect(advice).toContain("meta migrate --db <url> --dialect sqlite --slug <name> --apply");
  });

  describe("a D1 project (wrangler config with a D1 binding)", () => {
    const d1Project = (): string => {
      const root = project();
      writeFileSync(
        join(root, "wrangler.toml"),
        `name = "app"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "clinic-db"\ndatabase_id = "x"\n`,
      );
      return root;
    };

    test("advice uses --dialect d1 with its binding, and wrangler to apply", async () => {
      const metadata = await load([PET, PAYLOAD]);
      const advice = await genMigrateAdvice(input({ metadata, projectRoot: d1Project() }));
      expect(advice).toContain("meta migrate --dialect d1 --d1 DB --slug <name>");
      expect(advice).toContain("wrangler d1 migrations apply clinic-db --local");
      expect(advice).not.toContain("--dialect sqlite");
    });

    test("only a value payload's file changed → no advice (it has no table)", async () => {
      const metadata = await load([PET, PAYLOAD]);
      expect(await genMigrateAdvice(input({
        metadata, projectRoot: d1Project(),
        changedFiles: ["src/db/generated/TriagePayload.ts", "src/render/generated/prompts.ts"],
      }))).toBeUndefined();
    });
  });
});
