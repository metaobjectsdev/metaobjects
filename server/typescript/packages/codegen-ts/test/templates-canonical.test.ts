// Byte-identity gate: the package's bundled doc template MUST be a byte-for-byte
// copy of the repo-root canonical template at templates/docs/entity-page.md.mustache.
//
// Repo-root templates/ is the single canonical source of truth. The package keeps
// its own bundled copy (shipped in the npm tarball) which is reproduced from the
// canonical source via scripts/sync-doc-templates.sh. This test ensures the bundled
// copy can never silently fork from the canonical source.

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Walk UP from this test file's dir until we find a dir containing BOTH
// templates/ and server/ — that's the repo root. No hardcoded absolute paths.
function findRepoRoot(start: string): string {
  let dir = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(dir, "templates")) && existsSync(join(dir, "server"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate repo root (dir containing templates/ and server/)");
    }
    dir = parent;
  }
}

describe("doc templates — root canonical / package copy byte-identity", () => {
  it("package entity-page.md.mustache is byte-identical to repo-root canonical", () => {
    const repoRoot = findRepoRoot(import.meta.dir);

    const rootPath = join(repoRoot, "templates", "docs", "entity-page.md.mustache");
    const pkgPath = join(
      repoRoot,
      "server",
      "typescript",
      "packages",
      "codegen-ts",
      "templates",
      "docs",
      "entity-page.md.mustache",
    );

    const root = readFileSync(rootPath, "utf-8");
    const pkg = readFileSync(pkgPath, "utf-8");

    expect(pkg).toEqual(root);
  });
});
