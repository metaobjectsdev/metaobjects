/**
 * docs/features/adopting-existing-models.md, end to end, on the two TypeScript projects under
 * examples/brownfield/. Each test does what the recipe tells an agent to do: generate beside the
 * existing code, prove the two match, see the proof fail on a deliberate mismatch, move one call
 * site, then retire the old code.
 *
 * The proof is `tsc` over a test file the recipe writes. No MetaObjects command reads the
 * project's source. That is the point of the recipe, so the mismatches below are caught by
 * `tsc`, by Zod and by `meta verify --db`, each on the thing it can see.
 *
 * The drizzle `verify --db` half needs a server: MIGRATE_TS_PG_URL (the ts-slow lane's sidecar).
 * Each run creates a database of its own and drops it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { run } from "../../src/index.js";

const CLI_ROOT = resolve(import.meta.dirname, "../..");
const TSC_BIN = join(CLI_ROOT, "node_modules", ".bin", "tsc");
const EXAMPLES = resolve(CLI_ROOT, "../../../../examples/brownfield");
// Under the cli package so the example resolves zod, drizzle-orm and @types/node through the
// workspace (gitignored). The examples carry no package.json of their own.
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");
const PG_URL = process.env.MIGRATE_TS_PG_URL;

function project(name: "drizzle" | "zod"): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, `brownfield-${name}-`));
  cpSync(join(EXAMPLES, name), root, { recursive: true });
  return root;
}

function tsc(root: string): { code: number; output: string } {
  const p = Bun.spawnSync([TSC_BIN, "-p", join(root, "tsconfig.json")], { cwd: root });
  return { code: p.exitCode, output: `${p.stdout.toString()}${p.stderr.toString()}` };
}

function bun(root: string, script: string): { code: number; output: string } {
  const p = Bun.spawnSync([process.execPath, script], { cwd: root });
  return { code: p.exitCode, output: `${p.stdout.toString()}${p.stderr.toString()}` };
}

function edit(root: string, file: string, from: string, to: string): void {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  expect(text).toContain(from);
  writeFileSync(path, text.replace(from, to));
}

let roots: string[] = [];
let quiet: { log: typeof console.log; error: typeof console.error };
beforeEach(() => {
  roots = [];
  quiet = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
});
afterEach(() => {
  console.log = quiet.log;
  console.error = quiet.error;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function fresh(name: "drizzle" | "zod"): string {
  const root = project(name);
  roots.push(root);
  return root;
}

describe("brownfield recipe — Drizzle", () => {
  test("the generated tables match the hand-written ones, and the recipe runs to retiring them", async () => {
    const root = fresh("drizzle");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    expect(tsc(root)).toEqual({ code: 0, output: "" });

    // One call site moves. The other still reads the old schema, and both compile.
    edit(
      root,
      "src/customers.ts",
      'import { type Customer, customers, type NewCustomer } from "./db/schema.js";',
      'import { type Customer, customers, type CustomerInsert as NewCustomer } from "./generated/Customer.js";',
    );
    expect(tsc(root)).toEqual({ code: 0, output: "" });

    // The rest moves, the old schema becomes re-exports, the proof goes, and verify still passes.
    edit(
      root,
      "src/orders.ts",
      'import { type NewOrder, type Order, orders } from "./db/schema.js";',
      'import { type OrderInsert as NewOrder, type Order, orders } from "./generated/Order.js";',
    );
    writeFileSync(
      join(root, "src/db/schema.ts"),
      'export { customers } from "../generated/Customer.js";\nexport { orders } from "../generated/Order.js";\n',
    );
    rmSync(join(root, "proof"), { recursive: true });
    expect(tsc(root)).toEqual({ code: 0, output: "" });
    expect(await run(["verify", "--cwd", root])).toBe(0);
  }, 120_000);

  test("tsc names the field when the model stops matching the existing types", async () => {
    const root = fresh("drizzle");
    edit(root, "metaobjects/meta.shop.yaml", '{ name: tags, required: true, default: "{}" }', "{ name: tags, required: true }");
    edit(root, "metaobjects/meta.shop.yaml", "{ name: notes }", "{ name: notes, required: true }");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    const { code, output } = tsc(root);
    expect(code).not.toBe(0);
    expect(output).toContain(`Type '"tags"' does not satisfy the constraint 'never'`);
    expect(output).toContain(`Type '"notes"' does not satisfy the constraint 'never'`);
  }, 120_000);

  test("without timestampMode the proof catches a Date column generated as a string", async () => {
    const root = fresh("drizzle");
    edit(root, "metaobjects.config.ts", '  timestampMode: "date", // the existing timestamp columns read as Date\n', "");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    const { code, output } = tsc(root);
    expect(code).not.toBe(0);
    expect(output).toContain(`Type '"createdAt"' does not satisfy the constraint 'never'`);
  }, 120_000);

  describe("meta verify --db (postgres, env-gated)", () => {
    if (PG_URL === undefined || PG_URL.length === 0) {
      // The ts-slow lane arms this: there the URL is the sidecar's, and a missing one is a broken
      // lane, not a skip.
      if (process.env.MIGRATE_TS_PG_EXPECT === "1") {
        test("MIGRATE_TS_PG_URL is set where MIGRATE_TS_PG_EXPECT=1 says a Postgres is", () => {
          expect(PG_URL).toBeDefined();
        });
      } else {
        test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
      }
      return;
    }

    test("the model matches the database the app runs; a wrong column tsc cannot see fails", async () => {
      const dbName = `mo_brownfield_${process.pid}_${Date.now()}`;
      const admin = new pg.Client({ connectionString: PG_URL });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${dbName}`);
      const url = new URL(PG_URL);
      url.pathname = `/${dbName}`;
      const root = fresh("drizzle");
      try {
        const db = new pg.Client({ connectionString: url.toString() });
        await db.connect();
        await db.query(readFileSync(join(root, "db/schema.sql"), "utf8"));
        await db.end();

        expect(await run(["gen", "--cwd", root])).toBe(0);
        expect(await run(["verify", "--cwd", root, "--db", url.toString()])).toBe(0);

        // The physical column is not in the type, so the proof passes and only the database
        // comparison can fail.
        edit(root, "metaobjects/meta.shop.yaml", "{ name: displayName, required: true,", "{ name: displayName, column: display_nam, required: true,");
        expect(await run(["gen", "--cwd", root])).toBe(0);
        expect(tsc(root)).toEqual({ code: 0, output: "" });
        expect(await run(["verify", "--cwd", root, "--db", url.toString()])).toBe(1);
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await admin.end();
      }
    }, 120_000);
  });
});

describe("brownfield recipe — Zod", () => {
  test("the generated schemas match the hand-written ones, and the recipe runs to retiring them", async () => {
    const root = fresh("zod");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    expect(tsc(root)).toEqual({ code: 0, output: "" });
    expect(bun(root, "proof/rules.ts").code).toBe(0);

    // One call site moves; the other still parses with the old schema.
    edit(
      root,
      "src/shipping.ts",
      'import { Address } from "./api/schemas.js";',
      'import { type Address, AddressInsertSchema } from "./generated/Address.js";',
    );
    edit(root, "src/shipping.ts", "return Address.parse(body);", "return AddressInsertSchema.parse(body);");
    expect(tsc(root)).toEqual({ code: 0, output: "" });

    edit(
      root,
      "src/signup.ts",
      'import { CreateCustomer } from "./api/schemas.js";',
      'import { type CreateCustomer, CreateCustomerInsertSchema } from "./generated/CreateCustomer.js";',
    );
    edit(root, "src/signup.ts", "return CreateCustomer.parse(body);", "return CreateCustomerInsertSchema.parse(body);");
    rmSync(join(root, "src/api"), { recursive: true });
    rmSync(join(root, "proof"), { recursive: true });
    expect(tsc(root)).toEqual({ code: 0, output: "" });
    expect(await run(["verify", "--cwd", root])).toBe(0);
  }, 120_000);

  test("tsc names a type mismatch, on input and on output", async () => {
    const root = fresh("zod");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    edit(root, "src/api/schemas.ts", "seats: z.number().int().optional()", "seats: z.string().optional()");
    const { code, output } = tsc(root);
    expect(code).not.toBe(0);
    expect(output.match(/Type '"seats"' does not satisfy the constraint 'never'/g)?.length).toBe(2);
  }, 120_000);

  test("tsc names an optional field present on one side, which mutual assignability would pass", async () => {
    const root = fresh("zod");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    edit(root, "src/api/schemas.ts", "tags: z.array(z.string()),", "tags: z.array(z.string()),\n  referrer: z.string().optional(),");
    const { code, output } = tsc(root);
    expect(code).not.toBe(0);
    expect(output).toContain(`Type '"referrer"' does not satisfy the constraint 'never'`);

    // The naive check this replaces: both directions assign, so it would have called these equal.
    writeFileSync(
      join(root, "proof/naive.ts"),
      `import type { z } from "zod";
import type { CreateCustomer } from "../src/api/schemas.js";
import type { CreateCustomerInsertSchema } from "../src/generated/CreateCustomer.js";
type A = z.input<typeof CreateCustomer>;
type B = z.input<typeof CreateCustomerInsertSchema>;
export const forward: B = {} as A;
export const backward: A = {} as B;
`,
    );
    expect(tsc(root).output).not.toContain("proof/naive.ts");
  }, 120_000);

  test("an existing string that accepts empty differs by rule, and the model can say so", async () => {
    const root = fresh("zod");
    edit(root, "src/api/schemas.ts", "displayName: z.string().min(1).max(120)", "displayName: z.string().max(120)");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    const rules = bun(root, "proof/rules.ts");
    expect(rules.code).not.toBe(0);
    expect(rules.output).toContain("minLength");

    edit(
      root,
      "metaobjects/meta.api.yaml",
      "- field.string: { name: displayName, required: true, maxLength: 120 }",
      "- field.string:\n              name: displayName\n              required: true\n              maxLength: 120\n              children:\n                - validator.length: { min: 0 }",
    );
    expect(await run(["gen", "--cwd", root])).toBe(0);
    expect(bun(root, "proof/rules.ts").code).toBe(0);
  }, 120_000);

  test("tsc names a field that became any, which assigns both ways", async () => {
    const root = fresh("zod");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    edit(root, "src/api/schemas.ts", "tags: z.array(z.string()),", "tags: z.any() as z.ZodType<any>,");
    const { code, output } = tsc(root);
    expect(code).not.toBe(0);
    expect(output).toContain(`Type '"tags"' does not satisfy the constraint 'never'`);
  }, 120_000);

  test("a rule the type cannot see passes tsc and fails the JSON Schema comparison", async () => {
    const root = fresh("zod");
    expect(await run(["gen", "--cwd", root])).toBe(0);
    edit(root, "src/api/schemas.ts", "email: z.string().min(1).max(254)", "email: z.string().min(1).max(100)");
    expect(tsc(root)).toEqual({ code: 0, output: "" });
    const rules = bun(root, "proof/rules.ts");
    expect(rules.code).not.toBe(0);
    expect(rules.output).toContain("maxLength");
  }, 120_000);
});
