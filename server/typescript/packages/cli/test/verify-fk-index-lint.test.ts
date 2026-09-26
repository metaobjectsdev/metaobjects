/**
 * `meta verify` — the unindexed-foreign-key authoring lint.
 *
 * `meta migrate` emits a FOREIGN KEY for every enforced `identity.reference` and no index
 * for its columns: Postgres and SQLite index the referenced side only. Every join from the
 * parent, and every ON DELETE from it, then scans the child table. Generating that index
 * automatically would propose a migration to every existing adopter in a patch release, so
 * this is ADVISORY: it names each foreign key with no index covering its columns and says
 * how to declare one. It never changes the exit code.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCommand } from "../src/commands/verify.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "tracker",
    children: [
      { "object.entity": { name: "Project", children: [
        { "source.rdb": { "@table": "projects" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Member", children: [
        { "source.rdb": { "@table": "members" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Issue", children: [
        { "source.rdb": { "@table": "issues" } },
        { "field.long": { name: "id" } },
        // Unindexed: the lint must name it.
        { "field.long": { name: "projectId", "@required": true } },
        // Covered by an index.lookup whose leading field is the FK column.
        { "field.long": { name: "assigneeId" } },
        { "field.string": { name: "status" } },
        // Covered by @unique (an implicit unique index).
        { "field.long": { name: "ownerId", "@unique": true } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        { "identity.reference": { name: "fkProject", "@fields": ["projectId"], "@references": "Project" } },
        { "identity.reference": { name: "fkAssignee", "@fields": ["assigneeId"], "@references": "Member" } },
        { "identity.reference": { name: "fkOwner", "@fields": ["ownerId"], "@references": "Member" } },
        { "index.lookup": { name: "byAssignee", "@fields": ["assigneeId", "status"] } },
      ] } },
    ],
  },
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verify-fk-index-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.tracker.json"), MODEL, "utf8");
  return root;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    return { code: await fn(), out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

describe("meta verify — unindexed foreign keys (advisory)", () => {
  test("names the unindexed FK, says how to declare the index, and does not fail the build", async () => {
    const root = await project();
    const { code, out } = await capture(() => verifyCommand([], root));
    expect(code).toBe(0);
    expect(out).toMatch(/1 foreign key\(s\) with no index/);
    expect(out).toContain("Issue.fkProject");
    expect(out).toContain("index.lookup");
    expect(out).toContain("projectId");
    expect(out).not.toContain("Issue.fkAssignee");
    expect(out).not.toContain("Issue.fkOwner");
  });

  test("--no-antipatterns suppresses it with the rest of the advisory tier", async () => {
    const root = await project();
    const { out } = await capture(() => verifyCommand(["--no-antipatterns"], root));
    expect(out).not.toContain("Issue.fkProject");
  });

  test("the structured payload carries the finding as an advisory row", async () => {
    const root = await project();
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
    const rows = payload.antiPatterns.rows.filter((r) => r.rule === "unindexed-foreign-key");
    expect(rows.map((r) => r.construct)).toEqual(["tracker::Issue.fkProject"]);
  });
});
