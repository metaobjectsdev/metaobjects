/**
 * `meta migrate --db` (the ONLINE, live-introspection path) and `migrate.scope`.
 *
 * The scope feature shipped with no test on this path at all — every existing scope
 * test drives either the offline diff or `verify --db`. It is also the path where a
 * wrong scope is most expensive: it introspects a real database and writes DDL.
 *
 * The case under test is the one that inverts: a scope matching NOTHING. It is
 * always an authoring error (a typo'd or stale package pattern), it can never be
 * what someone meant, and left alone it is silent — migrate reports "no changes"
 * having compared nothing, while an empty expected side is exactly what the diff
 * reads as "no model, govern the whole database". Refused, with the patterns and
 * the loaded FQNs named, so the author can see what missed.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/index.js";

const PLATFORM = JSON.stringify({
  "metadata.root": {
    package: "acme::platform",
    children: [{
      "object.entity": {
        name: "Job",
        children: [
          { "source.rdb": { name: "src", "@table": "jobs" } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "title" } },
          { "identity.primary": { name: "pk", "@fields": ["id"] } },
        ],
      },
    }],
  },
});

/** Another owner's package, sharing the database. */
const ARENA = JSON.stringify({
  "metadata.root": {
    package: "arena",
    children: [{
      "object.entity": {
        name: "Match",
        children: [
          { "source.rdb": { name: "src", "@table": "matches" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "pk", "@fields": ["id"] } },
        ],
      },
    }],
  },
});

function scaffold(): { repo: string; dbUrl: string } {
  const repo = mkdtempSync(join(tmpdir(), "metaobjects-migrate-scope-"));
  mkdirSync(join(repo, "metaobjects"), { recursive: true });
  writeFileSync(join(repo, "metaobjects", "meta.platform.json"), PLATFORM, "utf8");
  writeFileSync(join(repo, "metaobjects", "meta.arena.json"), ARENA, "utf8");
  return { repo, dbUrl: `file:${join(repo, "local.db")}` };
}

function declareScope(repo: string, scope: string[]): void {
  mkdirSync(join(repo, ".metaobjects"), { recursive: true });
  writeFileSync(
    join(repo, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, migrate: { scope } }),
    "utf8",
  );
}

const migrateFromDb = (repo: string, dbUrl: string): Promise<number> =>
  run(["migrate", "--from-db", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--slug", "initial"]);

let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta migrate --db — migrate.scope", () => {
  test("a scope matching NO loaded object is refused, naming the patterns and what was loaded", async () => {
    const { repo, dbUrl } = scaffold();
    try {
      declareScope(repo, ["typo::**"]);
      expect(await migrateFromDb(repo, dbUrl)).toBe(2);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("matched none");
      // The patterns that missed, and the shape they had to match — an author
      // cannot fix a typo from "your scope matched nothing" alone.
      expect(all).toContain("typo::**");
      expect(all).toContain("acme::platform::Job");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a scope that matches something still runs (the refusal is not a blanket break)", async () => {
    const { repo, dbUrl } = scaffold();
    try {
      declareScope(repo, ["acme::platform::**"]);
      expect(await migrateFromDb(repo, dbUrl)).toBe(0);
      const all = [...out, ...err].join("\n");
      expect(all).not.toContain("matched none");
      // `matches` belongs to the other owner: reported as out-of-scope, never created.
      expect(all).toContain("out-of-scope");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("no migrate.scope declared — unchanged, both tables governed", async () => {
    const { repo, dbUrl } = scaffold();
    try {
      expect(await migrateFromDb(repo, dbUrl)).toBe(0);
      const all = [...out, ...err].join("\n");
      expect(all).not.toContain("matched none");
      expect(all).not.toContain("out-of-scope");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
