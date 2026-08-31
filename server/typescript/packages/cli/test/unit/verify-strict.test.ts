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

  // ── The remedy `verify` prints, which is a separate contract from the exit code ──
  //
  // Two failures reach the same catch and need OPPOSITE advice. For a typo the generic
  // three exits are right. For a RETIRED attribute the middle one — the `attr.properties`
  // bag — is actively harmful: that bag is exempt from the strict-attr check BY SUBTYPE, so
  // it loads, and the value then reaches nothing. Following the printed advice would turn a
  // correct, loud failure into a green `meta verify` over metadata that no longer means what
  // the author wrote.
  //
  // Asserting on stderr rather than the exit code because BOTH cases exit 1 — the exit code
  // cannot tell the two apart, which is exactly why this went unnoticed.
  function captureErrors(fn: () => Promise<number>): Promise<{ code: number; err: string }> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    return fn().then(
      (code) => { console.error = original; return { code, err: lines.join("\n") }; },
      (e) => { console.error = original; throw e; },
    );
  }

  test("a RETIRED attr prints its own exits, and never the attr.properties bag", async () => {
    writeFileSync(
      join(dir, "metaobjects", "meta.users.json"),
      JSON.stringify({
        "metadata.root": {
          package: "acme::users",
          children: [
            {
              "object.entity": {
                name: "Account",
                // FR-040: never registered vocabulary, so it passed `meta gen` (open
                // load) and failed `meta verify` (strict) — the defect this closes.
                "@emitRoutes": false,
                children: [
                  { "field.long": { name: "id" } },
                  { "identity.primary": { name: "pk", "@fields": ["id"] } },
                ],
              },
            },
          ],
        },
      }),
    );
    const { verifyCommand } = await import("../../src/commands/verify.js");
    const { code, err } = await captureErrors(() => verifyCommand([], dir));
    expect(code).toBe(1);
    // Asserting the SHAPE, not the release number: this test's subject is which remedy
    // gets printed, and pinning the version here would make it fail at the next cut for a
    // reason that has nothing to do with what it checks.
    expect(err).toContain("retired in");
    expect(err).toContain("meta upgrade --apply");
    expect(err).toContain("emit-attrs-to-generator-config.md");
    expect(err).not.toContain("attr.properties");
  });

  test("a TYPO still gets the generic three exits — that advice is correct for it", async () => {
    writeMadeUpAttrMeta();
    const { verifyCommand } = await import("../../src/commands/verify.js");
    const { code, err } = await captureErrors(() => verifyCommand([], dir));
    expect(code).toBe(1);
    // The properties bag IS the right answer for an arbitrary author-supplied property.
    expect(err).toContain("attr.properties");
    expect(err).not.toContain("meta upgrade --apply");
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
