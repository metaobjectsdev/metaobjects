// server/typescript/packages/cli/test/unit/verify-strict.test.ts
//
// Issue #96 — `meta verify` is strict-by-default (ADR-0023 cross-port
// consistency): an undeclared/typo'd own @attr now FAILS verify (exit 1,
// ERR_UNKNOWN_ATTR) unless `--lax` is passed. This closes the gap where Java's
// Maven verify rejected the attr but the TS/Python CLIs silently passed.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Shared cross-port fixture (also asserted by the Python CLI verify-strict test):
// a registered field.string carrying one undeclared own @attr.
const FIXTURE_ROOT = join(
  import.meta.dir,
  "..", // test
  "..", // cli
  "..", // packages
  "..", // typescript
  "..", // server
  "..", // repo root
  "fixtures",
  "verify-strict-conformance",
  "unregistered-attr",
);
const MADE_UP_META = readFileSync(
  join(FIXTURE_ROOT, "input", "meta.users.json"),
  "utf8",
);

describe("meta verify — strict-by-default (#96)", () => {
  let dir: string;
  let cwdBefore: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "verify-strict-"));
    cwdBefore = process.cwd();
    process.chdir(dir);
    mkdirSync(join(dir, "metaobjects"));
  });
  afterEach(() => {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  // The shared fixture: a field.string carrying a made-up attr no provider declares.
  function writeMadeUpAttrMeta(): void {
    writeFileSync(join(dir, "metaobjects", "meta.users.json"), MADE_UP_META);
  }

  test("FAILS (exit 1) on an undeclared own @attr by default (strict)", async () => {
    writeMadeUpAttrMeta();
    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand([], dir);
    expect(code).toBe(1);
  });

  test("PASSES (exit 0) on the same metadata with --lax", async () => {
    writeMadeUpAttrMeta();
    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand(["--lax"], dir);
    expect(code).toBe(0);
  });

  test("clean metadata passes under strict (no false positive)", async () => {
    writeFileSync(
      join(dir, "metaobjects", "meta.users.json"),
      JSON.stringify({
        "metadata.root": {
          package: "acme::users",
          children: [
            {
              "object.entity": {
                name: "Account",
                children: [
                  { "field.long": { name: "id" } },
                  { "field.string": { name: "email", "@description": "the email" } },
                  { "identity.primary": { name: "pk", "@fields": ["id"] } },
                ],
              },
            },
          ],
        },
      }),
    );
    const { verifyCommand } = await import("../../src/commands/verify.js");
    const code = await verifyCommand([], dir);
    expect(code).toBe(0);
  });
});
