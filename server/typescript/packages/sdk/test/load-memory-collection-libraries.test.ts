// `loadMemory(repoRoot)` with no `files` takes EVERYTHING the collection contributes from
// the collection — including the shipped-library selection.
//
// The no-`files` arm is the embedder's door: a script or tool that calls `loadMemory` on a
// project directory and expects what `meta` loads. It took the files, file ids and the
// dependency imports from `resolveCollection`, but not `libraries`, which FR-043 moved into
// `.metaobjects/config.json` beside them. A project opting into `iam` therefore loaded
// through `meta` and failed through `loadMemory(repoRoot)`: every reference into the library
// was ERR_INVALID_REFERENCE. Same shape as #333, one door over — the routed commands thread
// `collectionLoadOptions`, and this arm had its own list.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "../src/memory.js";

async function project(files: Record<string, string>, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "load-memory-libraries-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CONFIG_OPTING_INTO_IAM = JSON.stringify({ schema_version: 1, sources: [], libraries: ["iam"] });

const REFERENCES_THE_LIBRARY = `
metadata:
  package: acme::app
  children:
    - object.entity:
        name: Note
        children:
          - field.uuid: { name: id }
          - field.uuid: { name: authorId }
          - identity.primary: { name: pk, fields: [id] }
          - identity.reference: { name: authorRef, fields: [authorId], references: "metaobjects::iam::User" }
`;

const COPY_OF_A_SHIPPED_NODE = `
metadata:
  package: metaobjects::iam
  children:
    - object.entity:
        name: User
        children:
          - field.string: { name: nickname }
`;

describe("loadMemory(repoRoot) loads the libraries the project's config opts into", () => {
  test("a reference into an opted-in library resolves", async () => {
    await project(
      { ".metaobjects/config.json": CONFIG_OPTING_INTO_IAM, "metaobjects/app.yaml": REFERENCES_THE_LIBRARY },
      async (dir) => {
        const root = await loadMemory(dir, { strict: true });
        expect(root.objects().map((o) => o.resolutionKey())).toContain("metaobjects::iam::User");
      },
    );
  });

  test("the library-package guard applies to the config's selection too", async () => {
    await project(
      { ".metaobjects/config.json": CONFIG_OPTING_INTO_IAM, "metaobjects/iam.yaml": COPY_OF_A_SHIPPED_NODE },
      async (dir) => {
        const err = await loadMemory(dir, { strict: true }).then(() => undefined, (e: Error) => e);
        expect((err as { code?: string } | undefined)?.code).toBe("ERR_LIBRARY_PACKAGE_COLLISION");
      },
    );
  });
});
