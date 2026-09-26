/**
 * `meta verify` / `meta migrate` — a parent-side relationship the child side overrides.
 *
 * A 1:N may be declared on the parent (`Author` composition `books`) or on the FK-owning
 * child (`Book` association `author`). When both are declared and their subtypes imply
 * different referential actions, the FK-owning side governs (ADR-0047's precedence), so
 * the composition's cascade never reaches the constraint. An external reviewer authored
 * exactly this, got ON DELETE RESTRICT and a 409 on DELETE, and nothing said why.
 * Advisory: named in verify's anti-pattern tier and warned by migrate; never an exit code.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCommand } from "../src/commands/verify.js";
import { migrateCommand } from "../src/commands/migrate.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

function model(bookRefExtra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    "metadata.root": {
      package: "bookclub",
      children: [
        { "object.entity": { name: "Author", children: [
          { "source.rdb": { "@table": "authors" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          { "relationship.composition": { name: "books", "@objectRef": "Book", "@cardinality": "many" } },
        ] } },
        { "object.entity": { name: "Book", children: [
          { "source.rdb": { "@table": "books" } },
          { "field.long": { name: "id" } },
          { "field.long": { name: "authorId", "@required": true } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          { "identity.reference": { name: "authorRef", "@fields": ["authorId"], "@references": "Author", ...bookRefExtra } },
          { "index.lookup": { name: "byAuthorId", "@fields": ["authorId"] } },
          { "relationship.association": { name: "author", "@objectRef": "Author", "@cardinality": "one" } },
        ] } },
      ],
    },
  });
}

async function project(src: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verify-ra-conflict-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.bookclub.json"), src, "utf8");
  return root;
}

async function capture(fn: () => Promise<number>, keepStdout = true): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => { if (keepStdout) lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    return { code: await fn(), out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

describe("a parent-side relationship the child side overrides (advisory)", () => {
  test("verify names the FK, the governing action and the fix, and does not fail the build", async () => {
    const root = await project(model());
    const { code, out } = await capture(() => verifyCommand([], root));
    expect(code).toBe(0);
    expect(out).toMatch(/1 foreign key\(s\) whose two sides declare relationships that disagree/);
    expect(out).toContain("Book.authorRef");
    expect(out).toContain("ON DELETE restrict (not cascade)");
    expect(out).toContain("`onDelete: cascade`");
  });

  test("the structured payload carries it as an advisory row keyed to the FK", async () => {
    const root = await project(model());
    const lines: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    console.error = () => {};
    try {
      expect(await verifyCommand([], root, undefined, "json")).toBe(0);
    } finally {
      console.log = log;
      console.error = err;
    }
    const payload = JSON.parse(lines.join("\n")) as { antiPatterns: { rows: { rule: string; construct: string }[] } };
    const rows = payload.antiPatterns.rows.filter((r) => r.rule === "overridden-referential-action");
    expect(rows.map((r) => r.construct)).toEqual(["bookclub::Book.authorRef"]);
  });

  test("an action declared on the reference settles it: nothing reported", async () => {
    const root = await project(model({ "@onDelete": "cascade" }));
    const { out } = await capture(() => verifyCommand([], root));
    expect(out).not.toContain("Book.authorRef");
  });

  test("migrate warns while generating the DDL that carries the child's action", async () => {
    const root = await project(model());
    const db = join(root, "dev.sqlite");
    const { out } = await capture(() => migrateCommand(
      ["--from-db", "--db", `file:${db}`, "--dialect", "sqlite", "--slug", "init", "--dry-run"], root,
    ), false);
    expect(out).toContain("migrate: Book.authorRef:");
    expect(out).toContain("ON DELETE restrict (not cascade)");
  });
});
