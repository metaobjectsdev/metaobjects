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
 *
 * The near-miss variant matters just as much: a scope matching only value
 * objects and abstracts matches LOADED objects but none that can declare a
 * table or view — the run still compares nothing, so it is refused on the same
 * question, answered against the expected schema's provenance rather than the
 * loaded object set.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { run } from "../../src/index.js";
import { declareScope, scaffold } from "./support/scope-fixture.js";

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
    const { repo, dbUrl } = scaffold("metaobjects-migrate-scope-");
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

  test("a scope matching only value objects and abstracts is refused — they declare no table", async () => {
    const { repo, dbUrl } = scaffold("metaobjects-migrate-scope-");
    try {
      // `acme::shared` (scaffolded by the fixture) holds an abstract base and a
      // value object: loaded objects, but none that can contribute a table or
      // view. Matching them is not governing anything — the run would compare
      // nothing and report "no changes" against a database it was told to check.
      declareScope(repo, ["acme::shared::**"]);
      expect(await migrateFromDb(repo, dbUrl)).toBe(2);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("matched none");
      // The patterns that missed, and the table-declaring objects they could
      // have matched — the refusal is decided against those, not against every
      // loaded object.
      expect(all).toContain("acme::shared::**");
      expect(all).toContain("acme::platform::Job");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a scope that matches something still runs (the refusal is not a blanket break)", async () => {
    const { repo, dbUrl } = scaffold("metaobjects-migrate-scope-");
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

  test("--format json stays parseable under a scope — the out-of-scope note is text-format only", async () => {
    const { repo, dbUrl } = scaffold("metaobjects-migrate-scope-");
    try {
      declareScope(repo, ["acme::platform::**"]);
      expect(await run([
        "--format", "json", "migrate", "--from-db", "--cwd", repo,
        "--db", dbUrl, "--dialect", "sqlite", "--slug", "initial",
      ])).toBe(0);
      // The whole point: stdout is ONE machine-readable document. A prose line
      // ahead of it breaks `| jq` outright, which is how the out-of-scope note
      // shipped — unconditional `log.info`.
      const stdout = out.join("\n");
      expect(stdout).not.toContain("out-of-scope");
      expect(() => JSON.parse(stdout)).not.toThrow();
      // Moved to stderr, not dropped — an object that was neither created nor
      // dropped has to be reported somewhere, in every format.
      expect(err.join("\n")).toContain("out-of-scope");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("no migrate.scope declared — unchanged, both tables governed", async () => {
    const { repo, dbUrl } = scaffold("metaobjects-migrate-scope-");
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
