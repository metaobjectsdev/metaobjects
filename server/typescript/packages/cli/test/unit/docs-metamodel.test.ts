// FR-033 S3 — `meta docs --metamodel` CLI surface.
//
// Unlike --model/--api (which need a user's metadata + config), --metamodel
// documents the BUILT-IN metamodel from the strict registry: no metadata, no
// config, no project at all. It writes INDEX.md + per-type pages + providers.md
// under <out>/metamodel (default ./docs/metamodel), each carrying the @generated
// DO-NOT-EDIT header.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docsCommand } from "../../src/commands/docs.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "meta-metamodel-docs-"));
  dirs.push(d);
  return d;
}

describe("meta docs --metamodel", () => {
  test("emits the metamodel docs to <out> with the @generated header (no metadata/config needed)", async () => {
    const out = await tmp();
    // The cwd is an empty tmp dir — NO metaobjects/, NO metaobjects.config.ts.
    const code = await docsCommand(["--metamodel", "--out", out], out);
    expect(code).toBe(0);

    const files = (await readdir(out)).sort();
    expect(files).toContain("INDEX.md");
    expect(files).toContain("providers.md");
    expect(files).toContain("types");

    const index = await readFile(join(out, "INDEX.md"), "utf8");
    expect(index).toContain("@generated");
    expect(index).toContain("DO NOT EDIT");
    expect(index).toContain("meta docs --metamodel");
    expect(index).toContain("`field.currency`");

    // A per-type page lands under types/.
    const fieldPage = await readFile(join(out, "types", "field.md"), "utf8");
    expect(fieldPage).toContain("### field.currency");
    expect(fieldPage).toContain("metaobjects-ui");

    const providers = await readFile(join(out, "providers.md"), "utf8");
    expect(providers).toContain("metaobjects-documentation");
  });

  test("defaults the out dir to ./docs/metamodel when --out is omitted", async () => {
    const cwd = await tmp();
    const code = await docsCommand(["--metamodel"], cwd);
    expect(code).toBe(0);
    const files = await readdir(join(cwd, "docs", "metamodel"));
    expect(files.sort()).toContain("INDEX.md");
  });
});
