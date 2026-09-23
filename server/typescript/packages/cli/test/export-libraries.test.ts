// `meta export` loads the libraries the project opts into, like every other command.
//
// An adopter estate found it did not: `export` loaded the resolved file list alone, so a
// model referencing `metaobjects::iam::User` failed with "does not resolve to an object"
// under `export` while `gen`, `verify` and `migrate` loaded it clean — the one-rule-two-doors
// shape #333 already fixed for `libraries` once.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportCommand } from "../src/commands/export.js";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "meta-export-libs-"));
  mkdirSync(join(root, ".metaobjects"));
  writeFileSync(
    join(root, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, sources: [{ path: "model" }], libraries: ["iam"] }),
  );
  mkdirSync(join(root, "model"));
  writeFileSync(join(root, "model", "meta.app.json"), JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [{
        "object.entity": {
          name: "Note",
          children: [
            { "field.uuid": { name: "id" } },
            { "field.uuid": { name: "authorId" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
            { "identity.reference": { name: "authorRef", "@fields": ["authorId"], "@references": "metaobjects::iam::User" } },
          ],
        },
      }],
    },
  }));
  return root;
}

describe("meta export — libraries", () => {
  test("a reference into an opted-in library resolves, and the library is in the export", async () => {
    const root = project();
    try {
      const code = await exportCommand(["--out", "out.json"], root);
      expect(code).toBe(0);
      const json = readFileSync(join(root, "out.json"), "utf8");
      expect(json).toContain("\"Note\"");
      expect(json).toContain("metaobjects::iam");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
