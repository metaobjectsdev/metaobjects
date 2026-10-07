// The output contract an agent driving `meta` over a pipe relies on.
//
// Each block pins a defect found by running the published CLI against a scratch project:
//   - `--format json` must put exactly one parseable document on stdout. `meta gen` on a
//     fresh project printed a prose pointer ahead of the payload, `meta migrate` printed a
//     status line after it, and `migrate --dry-run` printed raw SQL instead of it — so
//     `meta gen --format json | jq` failed outright.
//   - an unknown flag names the command and lists its valid flags, in one wording, and
//     exits 2; it used to come in three spellings, one of them Node's parser text.
//   - `types --limit abc` was read as `0`, the UNLIMITED sentinel, and printed every row.
//   - `verify --db` reported a database it could not reach as schema drift.
//   - the offline `migrate` path refused to infer the dialect its help says it infers.
//   - `-V` was refused, and `--version` loaded the whole command graph first.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../src/index.js";
import { cliVersion } from "../src/lib/version.js";

// Commands lazily import heavy modules (migrate-ts, codegen) on first dispatch.
const TIMEOUT_MS = 60_000;

const SHOP_JSON = JSON.stringify({
  "metadata.root": {
    package: "shop",
    children: [
      {
        "object.entity": {
          name: "Customer",
          children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "email", "@maxLength": 200 } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

interface Captured {
  exit: number;
  out: string;
  err: string;
}

async function capture(args: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  try {
    const exit = await run(args);
    return { exit, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "meta-agent-contract-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", type: "module", private: true }));
  expect(await run(["init", "--quiet", "--cwd", dir])).toBe(0);
  writeFileSync(join(dir, "metaobjects", "meta.shop.json"), SHOP_JSON);
}, TIMEOUT_MS);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("--format json puts exactly one parseable document on stdout", () => {
  // Order matters: the from-db apply writes the snapshot the later offline runs diff against.
  const db = () => `file:${join(dir, "dev.sqlite")}`;
  const cases: Array<{ name: string; args: () => string[]; check?: (doc: Record<string, unknown>, r: Captured) => void }> = [
    { name: "gen with no generators wired", args: () => ["gen"] },
    { name: "gen --dry-run", args: () => ["gen", "--dry-run"] },
    { name: "gen --list", args: () => ["gen", "--list"] },
    { name: "verify", args: () => ["verify"] },
    { name: "verify --codegen", args: () => ["verify", "--codegen"] },
    { name: "types (no match)", args: () => ["types", "zzz-no-such-construct"] },
    { name: "types (match)", args: () => ["types", "field.string"] },
    { name: "deps list", args: () => ["deps", "list"] },
    { name: "eject --list", args: () => ["eject", "--list"] },
    { name: "migrate offline, no snapshot yet (error document)", args: () => ["migrate", "--dialect", "sqlite", "--dry-run"] },
    { name: "migrate baseline --dry-run", args: () => ["migrate", "baseline", "--dialect", "sqlite", "--dry-run"] },
    {
      name: "migrate --from-db --dry-run carries the SQL in the document",
      args: () => ["migrate", "--from-db", "--db", db(), "--slug", "init", "--dry-run"],
      check: (doc) => {
        const sql = doc.sql as { up: string; down: string };
        expect(sql.up).toMatch(/CREATE TABLE/i);
        expect(sql.down).toMatch(/DROP TABLE/i);
      },
    },
    {
      name: "migrate --from-db --apply",
      args: () => ["migrate", "--from-db", "--db", db(), "--slug", "init", "--apply"],
      check: (doc, r) => {
        expect(doc.summary).toContain("applied 1 migration(s)");
        expect(r.err).toContain("migrate: applied 1 migration(s)");
      },
    },
    {
      name: "migrate --from-db --apply again (no-op)",
      args: () => ["migrate", "--from-db", "--db", db(), "--slug", "init", "--apply"],
      check: (doc) => expect(doc.summary).toBe("no schema changes"),
    },
    {
      name: "migrate offline with no changes",
      args: () => ["migrate", "--dialect", "sqlite", "--slug", "x", "--dry-run"],
      check: (doc) => expect(doc.summary).toBe("no schema changes"),
    },
    {
      name: "verify --db against a database it cannot open",
      args: () => ["verify", "--db", "file:/nonexistent-meta-dir/x.sqlite"],
      check: (doc) => {
        expect(doc.errors).toEqual([{ gate: "schema", error: expect.any(String) }]);
        expect(doc.summary).toContain("1 gate(s) could not run (schema)");
        expect(doc.summary).not.toContain("failed (schema)");
        expect((doc.help as string[]).join("\n")).toContain("not drift");
      },
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const r = await capture([...c.args(), "--format", "json", "--cwd", dir]);
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(r.out) as Record<string, unknown>;
      } catch {
        throw new Error(`stdout is not one JSON document (exit ${r.exit}):\n${r.out}`);
      }
      c.check?.(doc, r);
    }, TIMEOUT_MS);
  }

  test("the offline migrate path infers the dialect from --db, as its help says", async () => {
    const r = await capture(["migrate", "--db", db(), "--slug", "x", "--dry-run", "--format", "json", "--cwd", dir]);
    expect(r.exit).toBe(0);
    expect(r.err).not.toContain("--dialect required");
    expect((JSON.parse(r.out) as { summary: string }).summary).toBe("no schema changes");
  }, TIMEOUT_MS);

  test("text format still prints the dry-run SQL preview", async () => {
    writeFileSync(
      join(dir, "metaobjects", "meta.shop.json"),
      SHOP_JSON.replace('{"field.string":{"name":"email"', '{"field.string":{"name":"phone"}},{"field.string":{"name":"email"'),
    );
    const r = await capture(["migrate", "--dialect", "sqlite", "--slug", "add-phone", "--dry-run", "--format", "text", "--cwd", dir]);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("-- UP --");
    expect(r.out).toMatch(/ADD COLUMN "phone"/);
    writeFileSync(join(dir, "metaobjects", "meta.shop.json"), SHOP_JSON);
  }, TIMEOUT_MS);
});

describe("an unknown flag names the command and lists its valid flags (exit 2)", () => {
  const commands: Array<{ argv: string[]; command: string; aValidFlag: string }> = [
    { argv: ["init"], command: "init", aValidFlag: "--force" },
    { argv: ["agent-docs"], command: "agent-docs", aValidFlag: "--server" },
    { argv: ["gen"], command: "gen", aValidFlag: "--dry-run" },
    { argv: ["verify"], command: "verify", aValidFlag: "--codegen" },
    { argv: ["migrate"], command: "migrate", aValidFlag: "--slug" },
    { argv: ["export"], command: "export", aValidFlag: "--out" },
    { argv: ["fmt"], command: "fmt", aValidFlag: "--check" },
    { argv: ["eject"], command: "eject", aValidFlag: "--list" },
    { argv: ["deps", "sync"], command: "deps", aValidFlag: "--dry-run" },
    { argv: ["prompt-snapshot"], command: "prompt-snapshot", aValidFlag: "--check" },
    { argv: ["generator", "new", "x"], command: "generator", aValidFlag: "--scope" },
    { argv: ["types"], command: "types", aValidFlag: "--limit" },
    { argv: ["docs"], command: "docs", aValidFlag: "--out, -o" },
    { argv: ["upgrade"], command: "upgrade", aValidFlag: "--apply" },
  ];
  for (const c of commands) {
    test(`meta ${c.argv.join(" ")} --bogus`, async () => {
      const r = await capture([...c.argv, "--bogus", "--cwd", dir]);
      expect(r.exit).toBe(2);
      const all = `${r.out}\n${r.err}`;
      expect(all).toContain(`unknown flag --bogus for \`meta ${c.command}\`. Valid flags: `);
      expect(all).toContain(c.aValidFlag);
      // Node's own parser wording must not leak through.
      expect(all).not.toContain("To specify a positional argument");
    }, TIMEOUT_MS);
  }
});

describe("numeric flags refuse non-numbers (exit 2)", () => {
  test("types --limit abc", async () => {
    const r = await capture(["types", "--limit", "abc"]);
    expect(r.exit).toBe(2);
    expect(r.err).toContain("invalid --limit 'abc'");
  }, TIMEOUT_MS);

  test("types --limit 0 still means unlimited", async () => {
    expect((await capture(["types", "--limit", "0"])).exit).toBe(0);
  }, TIMEOUT_MS);

  for (const cmd of ["gen", "verify"]) {
    test(`${cmd} --limit abc`, async () => {
      const r = await capture([cmd, "--limit", "abc", "--cwd", dir]);
      expect(r.exit).toBe(2);
      expect(r.err).toContain("invalid --limit 'abc'");
    }, TIMEOUT_MS);
  }
});

describe("metadata that does not load exits 1 in every command", () => {
  test("gen, verify, docs, migrate and export agree", async () => {
    const broken = join(dir, "metaobjects", "meta.broken.json");
    writeFileSync(broken, '{ "metadata.root": { "children": [ ');
    try {
      for (const argv of [["gen"], ["verify"], ["docs"], ["migrate", "--dialect", "sqlite"], ["export"]]) {
        const r = await capture([...argv, "--cwd", dir]);
        expect({ argv, exit: r.exit }).toEqual({ argv, exit: 1 });
      }
    } finally {
      rmSync(broken);
    }
  }, TIMEOUT_MS);
});

describe("the scaffold and its re-run", () => {
  test("a fresh init passes fmt --check", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "meta-fresh-fmt-"));
    try {
      expect(await run(["init", "--quiet", "--cwd", fresh])).toBe(0);
      expect((await capture(["fmt", "--check", "--cwd", fresh])).exit).toBe(0);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("init on an initialized project is a no-op that exits 0", async () => {
    const r = await capture(["init", "--cwd", dir]);
    expect(r.exit).toBe(0);
    expect(r.out).toContain("already initialized");
    expect(r.out).toContain("no-op");
  }, TIMEOUT_MS);
});

describe("version", () => {
  for (const flag of ["--version", "-v", "-V"]) {
    test(`run(${flag}) prints the bare version`, async () => {
      const r = await capture([flag]);
      expect(r.exit).toBe(0);
      expect(r.out).toBe(cliVersion());
    }, TIMEOUT_MS);
  }

  test("the bin answers a bare version flag before loading the command graph", () => {
    const bin = readFileSync(resolve(import.meta.dirname, "..", "bin", "meta.ts"), "utf8");
    // A static import of the dispatcher would evaluate the sdk and codegen-ts before the
    // version check — the whole graph paid on every probe.
    expect(bin).not.toMatch(/^import .*["']\.\.\/src\/index\.js["']/m);
    expect(bin).toContain('await import("../src/index.js")');
    const proc = Bun.spawnSync(["bun", resolve(import.meta.dirname, "..", "bin", "meta.ts"), "-V"]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe(cliVersion());
  }, TIMEOUT_MS);
});
