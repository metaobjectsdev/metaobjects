/**
 * `migrate.scope` — a `meta migrate` run governs only the objects it declares.
 *
 * Without this, "load everything" turns a real adopter's worst standing hazard —
 * a migrate proposing to DROP tables it does not model — from a discipline into
 * an automation. The suppression is BOTH-sided: the out-of-scope tables leave
 * the expected schema AND are excluded from the actual side, so the run neither
 * creates nor drops them.
 *
 * Boundary (deliberately unchanged): a table that NO loaded object declares is
 * still a proposed drop. Scope only silences tables whose declaring object was
 * loaded and fell outside it.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBaseline, runOfflineGenerate } from "../src/commands/migrate.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const PLATFORM = (extraField: boolean): string => JSON.stringify({
  "metadata.root": {
    package: "acme::platform",
    children: [{
      "object.entity": {
        name: "Job",
        children: [
          { "source.rdb": { name: "src", "@table": "jobs" } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "title", "@maxLength": 80 } },
          ...(extraField ? [{ "field.string": { name: "note" } }] : []),
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

/** Another owner's package, in the same database. */
const ARENA = (extraField: boolean): string => JSON.stringify({
  "metadata.root": {
    package: "arena",
    children: [{
      "object.entity": {
        name: "Match",
        children: [
          { "source.rdb": { name: "src", "@table": "matches" } },
          { "field.long": { name: "id" } },
          ...(extraField ? [{ "field.string": { name: "venue" } }] : []),
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "migrate-scope-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.platform.json"), PLATFORM(false), "utf8");
  await writeFile(join(root, "metaobjects", "meta.arena.json"), ARENA(false), "utf8");
  return root;
}

async function declareScope(root: string, scope: string[]): Promise<void> {
  await mkdir(join(root, ".metaobjects"), { recursive: true });
  await writeFile(
    join(root, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, migrate: { scope } }),
    "utf8",
  );
}

const cfg = () =>
  ({ dialect: "sqlite", outDir: "./.metaobjects/migrations", onAmbiguous: "abort",
     allow: [], slug: "auto", dryRun: false } as never);

const migrationDirs = async (root: string): Promise<string[]> =>
  (await readdir(join(root, ".metaobjects/migrations"))).filter((e) => !e.startsWith("."));

describe("meta migrate — migrate.scope", () => {
  test("an out-of-scope table is neither altered nor dropped", async () => {
    const root = await project();
    // Baseline BEFORE the scope is declared: the reference snapshot records both
    // owners' tables, exactly as a `--from-db` baseline of the shared database would.
    expect(await runBaseline(cfg(), root)).toBe(0);
    await declareScope(root, ["acme::platform::**"]);
    // The other owner evolves ITS model. Three outcomes are distinguishable here:
    // no scoping at all migrates the foreign column; scoping the EXPECTED side alone
    // proposes DROP TABLE "matches" (blocked → exit 1); correct both-sided
    // suppression produces silence.
    await writeFile(join(root, "metaobjects", "meta.arena.json"), ARENA(true), "utf8");

    expect(await runOfflineGenerate(cfg(), root)).toBe(0);
    expect(await migrationDirs(root)).toHaveLength(0);
  });

  test("in-scope changes still migrate under a scope", async () => {
    const root = await project();
    await runBaseline(cfg(), root);
    await declareScope(root, ["acme::platform::**"]);
    await writeFile(join(root, "metaobjects", "meta.platform.json"), PLATFORM(true), "utf8");

    expect(await runOfflineGenerate(cfg(), root)).toBe(0);
    const [dir] = await migrationDirs(root);
    expect(dir).toBeDefined();
    const up = await readFile(join(root, ".metaobjects/migrations", dir!, "up.sql"), "utf8");
    expect(up).toBe(`ALTER TABLE "jobs" ADD COLUMN "note" TEXT;\n`);
  });

  test("back-compat: with NO migrate.scope the emitted SQL is unchanged", async () => {
    const root = await project();
    await runBaseline(cfg(), root);
    await writeFile(join(root, "metaobjects", "meta.platform.json"), PLATFORM(true), "utf8");

    expect(await runOfflineGenerate(cfg(), root)).toBe(0);
    const [dir] = await migrationDirs(root);
    const up = await readFile(join(root, ".metaobjects/migrations", dir!, "up.sql"), "utf8");
    const down = await readFile(join(root, ".metaobjects/migrations", dir!, "down.sql"), "utf8");
    // Byte-for-byte what this project emitted before per-command scope existed.
    expect(up).toBe(`ALTER TABLE "jobs" ADD COLUMN "note" TEXT;\n`);
    expect(down).toBe(`ALTER TABLE "jobs" DROP COLUMN "note";\n`);
  });

  test("a table NO loaded object declares is still proposed for drop, scope or not", async () => {
    const root = await project();
    await runBaseline(cfg(), root);
    await declareScope(root, ["acme::platform::**"]);
    // The arena model leaves the collection entirely — nothing declares `matches`
    // any more, so migrate is back to its unchanged behaviour: propose the drop
    // (blocked here, since `allow` is empty → exit 1).
    await unlink(join(root, "metaobjects", "meta.arena.json"));

    expect(await runOfflineGenerate(cfg(), root)).toBe(1);
    expect(await migrationDirs(root)).toHaveLength(0);
  });

  test("a scope matching only value objects and abstracts is refused before the snapshot gate", async () => {
    const root = await project();
    // A package of shapes that can never declare a table: the scope matches
    // loaded objects, but none the run could actually govern.
    await writeFile(
      join(root, "metaobjects", "meta.shared.json"),
      JSON.stringify({
        "metadata.root": {
          package: "acme::shared",
          children: [
            { "object.entity": { name: "BaseRecord", abstract: true, children: [
              { "field.long": { name: "id" } },
            ] } },
            { "object.value": { name: "Address", children: [
              { "field.string": { name: "line1" } },
              { "field.string": { name: "line2" } },
            ] } },
          ],
        },
      }),
      "utf8",
    );
    await declareScope(root, ["acme::shared::**"]);
    // No baseline was run, so there is no snapshot: a run that got PAST the
    // refusal would report "no schema snapshot" — also exit 2 — so the message
    // is what pins that the scope error is the one reported, and that the
    // refusal fires before the snapshot is ever read.
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
    try {
      expect(await runOfflineGenerate(cfg(), root)).toBe(2);
    } finally {
      console.error = origErr;
    }
    const all = errors.join("\n");
    expect(all).toContain("matched none");
    expect(all).toContain("acme::shared::**");
    expect(all).toContain("acme::platform::Job");
  });
});
