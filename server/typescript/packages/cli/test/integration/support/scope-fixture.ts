/**
 * The two-owner project every `migrate.scope` integration test drives.
 *
 * `meta migrate` and `meta verify --db` govern the identical object set from ONE
 * declaration, so their integration tests scaffold the identical project — and
 * two copies of it had already drifted (`ARENA` was a constant in one file and a
 * `(venue: boolean)` factory in the other), which is how two tests that are
 * supposed to prove the same contract quietly stop testing the same thing.
 *
 * The shape: this consumer's `acme::platform` package owns `jobs`; a second
 * owner's `arena` package owns `matches` in the same database. A scope of
 * `["acme::platform::**"]` therefore governs exactly one of the two.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** This consumer's package. */
export const PLATFORM = JSON.stringify({
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

/**
 * Another owner's package, sharing the database.
 *
 * `venue` models a column the other owner has declared but not migrated yet —
 * drift for THEM, never for this consumer. Pass `false` for the base shape.
 */
export const arena = (opts: { venue: boolean } = { venue: false }): string => JSON.stringify({
  "metadata.root": {
    package: "arena",
    children: [{
      "object.entity": {
        name: "Match",
        children: [
          { "source.rdb": { name: "src", "@table": "matches" } },
          { "field.long": { name: "id" } },
          ...(opts.venue ? [{ "field.string": { name: "venue" } }] : []),
          { "identity.primary": { name: "pk", "@fields": ["id"] } },
        ],
      },
    }],
  },
});

/** Absolute path of the arena metadata file, for a test that rewrites it. */
export const arenaFile = (repo: string): string => join(repo, "metaobjects", "meta.arena.json");

/**
 * A package of shared SHAPES: an abstract base and a value object. Both are
 * loaded objects, but neither can declare a table or view — persistability
 * needs a writable source — so a `migrate.scope` over only this package
 * governs zero tables however well its patterns match.
 */
export const SHARED = JSON.stringify({
  "metadata.root": {
    package: "acme::shared",
    children: [
      {
        "object.entity": {
          name: "BaseRecord",
          abstract: true,
          children: [{ "field.long": { name: "id" } }],
        },
      },
      {
        "object.value": {
          name: "Address",
          children: [
            { "field.string": { name: "line1" } },
            { "field.string": { name: "line2" } },
          ],
        },
      },
    ],
  },
});

/**
 * A throwaway project holding both packages, plus the sqlite URL beside it.
 * `prefix` names the temp directory so a failing run says which suite made it.
 */
export function scaffold(prefix: string): { repo: string; dbUrl: string } {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(repo, "metaobjects"), { recursive: true });
  writeFileSync(join(repo, "metaobjects", "meta.platform.json"), PLATFORM, "utf8");
  writeFileSync(arenaFile(repo), arena(), "utf8");
  writeFileSync(join(repo, "metaobjects", "meta.shared.json"), SHARED, "utf8");
  return { repo, dbUrl: `file:${join(repo, "local.db")}` };
}

/** Declare `migrate.scope` on an existing scaffold — the ONE key both commands read. */
export function declareScope(repo: string, scope: string[]): void {
  mkdirSync(join(repo, ".metaobjects"), { recursive: true });
  writeFileSync(
    join(repo, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, migrate: { scope } }),
    "utf8",
  );
}
