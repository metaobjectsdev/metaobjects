/**
 * `meta verify` reports the two metadata/config refusals the expected-schema build can raise
 * as what they are, the way `meta migrate` does: an FK whose target is not a unique key
 * (exit 1, the reference named), and an unknown `migrate.conventions` preset (exit 2, the
 * presets named). Neither is "failed to introspect", and a typo'd preset is refused even
 * on a run with no --db.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCommand } from "../src/commands/verify.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

function model(references: string): string {
  return JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Person", children: [
      { "source.rdb": { "@table": "people" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "code" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] } },
    { "object.entity": { name: "Visit", children: [
      { "source.rdb": { "@table": "visits" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "personCode" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
      { "identity.reference": { name: "ref_person", "@fields": ["personCode"], "@references": references } },
    ] } },
  ] } });
}

async function project(references: string, migrate: Record<string, unknown> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verify-schema-refusals-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.acme.json"), model(references), "utf8");
  await mkdir(join(root, ".metaobjects"), { recursive: true });
  await writeFile(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, migrate }), "utf8");
  return root;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const code = await fn();
    return { code, out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

describe("meta verify — schema refusals", () => {
  test("--db: an FK to a non-unique target is refused by name, not as an introspection failure", async () => {
    const root = await project("Person.code");
    const { code, out } = await capture(() => verifyCommand(["--db", `file:${join(root, "t.db")}`], root));

    expect(code).toBe(1);
    expect(out).toContain('reference "ref_person" targets [code] on "Person"');
    expect(out).not.toContain("failed to introspect");
  });

  test("an unknown migrate.conventions preset is refused with exit 2, with or without --db", async () => {
    const root = await project("Person", { conventions: "hibernate" });

    const plain = await capture(() => verifyCommand([], root));
    expect(plain.code).toBe(2);
    expect(plain.out).toContain('migrate.conventions "hibernate" is not a schema-conventions preset');

    const withDb = await capture(() => verifyCommand(["--db", `file:${join(root, "t.db")}`], root));
    expect(withDb.code).toBe(2);
    expect(withDb.out).not.toContain("failed to introspect");
  });

  test("--db: an enum member longer than enums.maxLength is refused by name, not as an introspection failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "verify-schema-refusals-"));
    dirs.push(root);
    await mkdir(join(root, "metaobjects"), { recursive: true });
    await writeFile(join(root, "metaobjects", "meta.acme.json"), JSON.stringify({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Ticket", children: [
        { "source.rdb": { "@table": "tickets" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "status", "@values": ["OPEN", "IN_PROGRESS"] } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
    ] } }), "utf8");
    await mkdir(join(root, ".metaobjects"), { recursive: true });
    await writeFile(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, enums: { maxLength: 10 } }), "utf8");

    const { code, out } = await capture(() => verifyCommand(["--db", `file:${join(root, "t.db")}`], root));
    expect(code).toBe(1);
    expect(out).toContain('field.enum "Ticket.status" has the member "IN_PROGRESS"');
    expect(out).not.toContain("failed to introspect");

    // The same refusal under migrate.scope, whose scope check builds the expected schema first.
    await writeFile(join(root, ".metaobjects", "config.json"),
      JSON.stringify({ schema_version: 1, enums: { maxLength: 10 }, migrate: { scope: ["acme::*"] } }), "utf8");
    const scoped = await capture(() => verifyCommand(["--db", `file:${join(root, "t.db")}`], root));
    expect(scoped.code).toBe(1);
    expect(scoped.out).toContain('field.enum "Ticket.status" has the member "IN_PROGRESS"');
  });

  test("--db: a declared CHECK name two validators share is refused by name, not as an introspection failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "verify-schema-refusals-"));
    dirs.push(root);
    await mkdir(join(root, "metaobjects"), { recursive: true });
    await writeFile(join(root, "metaobjects", "meta.acme.json"), JSON.stringify({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Slot", children: [
        { "source.rdb": { "@table": "slots" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "a" } },
        { "field.long": { name: "b" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "validator.atLeastOne": { name: "one", "@fields": ["a", "b"], "@constraintName": "CK_Slot" } },
        { "validator.comparison": { name: "cmp", "@left": "a", "@op": "lt", "@right": "b", "@constraintName": "CK_Slot" } },
      ] } },
    ] } }), "utf8");
    await mkdir(join(root, ".metaobjects"), { recursive: true });
    await writeFile(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1 }), "utf8");

    const { code, out } = await capture(() => verifyCommand(["--db", `file:${join(root, "t.db")}`], root));
    expect(code).toBe(1);
    expect(out).toContain("ERR_CHECK_NAME");
    expect(out).toContain('CHECK "CK_Slot" on table "slots"');
    expect(out).not.toContain("failed to introspect");
  });
});
