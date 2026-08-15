import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";
import {
  checkVerifiedBy,
  ERR_REQUIREMENT_TEST_MISSING,
  WARN_REQUIREMENT_TEST_SKIPPED,
  WARN_REQUIREMENT_TEST_COMMENT_ONLY,
} from "../../src/lib/verified-by-scan.js";

/** Build a project on disk: metadata + whatever test files the case needs. */
function project(files: Record<string, string>, reqJson: string): string {
  const dir = mkdtempSync(join(tmpdir(), "vb-"));
  mkdirSync(join(dir, "metaobjects"), { recursive: true });
  writeFileSync(join(dir, "metaobjects", "meta.requirements.json"), reqJson);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  }
  return dir;
}

async function load(dir: string) {
  return await loadMemory(dir, { strict: true });
}

const req = (status: string, verifiedBy: string[]) =>
  JSON.stringify({
    "metadata.root": {
      package: "acme::shop",
      children: [
        {
          "requirement.functional": {
            name: "ordering",
            "@level": 3,
            "@status": status,
            "@statement": "Every placed order is recorded before payment.",
            "@violation": "A payment against an order that was never stored.",
            "@verifiedBy": verifiedBy,
          },
        },
      ],
    },
  });

describe("checkVerifiedBy", () => {
  test("a named test that exists is clean", async () => {
    const dir = project(
      { "test/order.test.ts": "test('OrderServiceTest', () => {});" },
      req("live", ["OrderServiceTest"]),
    );
    expect(checkVerifiedBy(await load(dir), dir)).toEqual([]);
  });

  test("a named test that exists nowhere is an ERROR on live", async () => {
    const dir = project(
      { "test/order.test.ts": "test('something else', () => {});" },
      req("live", ["OrderServiceTest"]),
    );
    const d = checkVerifiedBy(await load(dir), dir);
    expect(d).toHaveLength(1);
    expect(d[0]!.code).toBe(ERR_REQUIREMENT_TEST_MISSING);
    expect(d[0]!.severity).toBe("error");
    expect(d[0]!.message).toContain("OrderServiceTest");
  });

  // The asymmetry that governs @implementedBy governs this too: an abandoned
  // requirement naming a deleted test is the entry doing its job.
  test("the SAME missing test is silent on abandoned", async () => {
    const dir = project(
      { "test/order.test.ts": "test('something else', () => {});" },
      req("abandoned", ["OrderServiceTest"]),
    );
    expect(checkVerifiedBy(await load(dir), dir)).toEqual([]);
  });

  test("FAIL-OPEN: a project with no test files says nothing", async () => {
    const dir = project({ "src/index.ts": "export const x = 1;" }, req("live", ["OrderServiceTest"]));
    expect(checkVerifiedBy(await load(dir), dir)).toEqual([]);
  });

  test("a test that exists but is skipped WARNs rather than passing", async () => {
    const dir = project(
      { "test/order.test.ts": "test.skip('OrderServiceTest', () => {});" },
      req("live", ["OrderServiceTest"]),
    );
    const d = checkVerifiedBy(await load(dir), dir);
    expect(d).toHaveLength(1);
    expect(d[0]!.code).toBe(WARN_REQUIREMENT_TEST_SKIPPED);
    expect(d[0]!.severity).toBe("warn");
  });

  test("an annotation on the line above the declaration is detected", async () => {
    const dir = project(
      { "src/test/OrderServiceTest.java": "@Disabled\npublic class OrderServiceTest {}" },
      req("live", ["OrderServiceTest"]),
    );
    const d = checkVerifiedBy(await load(dir), dir);
    expect(d).toHaveLength(1);
    expect(d[0]!.code).toBe(WARN_REQUIREMENT_TEST_SKIPPED);
  });

  test.each([
    ["src/test/OrderServiceTest.java", "public class OrderServiceTest {}"],
    ["tests/test_orders.py", "def test_OrderServiceTest(): pass"],
    ["Tests/OrderServiceTests.cs", "public class OrderServiceTest {}"],
    ["src/test/OrderServiceTest.kt", "class OrderServiceTest"],
  ])("finds the test in %s", async (rel, body) => {
    const dir = project({ [rel]: body }, req("live", ["OrderServiceTest"]));
    expect(checkVerifiedBy(await load(dir), dir)).toEqual([]);
  });

  // `_` is a separator, not a word character: pytest's `def test_OrderServiceTest`
  // IS the test a claim naming `OrderServiceTest` means.
  test("an underscore-prefixed test name satisfies the claim", async () => {
    const dir = project(
      { "tests/test_orders.py": "def test_OrderServiceTest(): pass" },
      req("live", ["OrderServiceTest"]),
    );
    expect(checkVerifiedBy(await load(dir), dir)).toEqual([]);
  });

  // Precision: a claim naming `Order` must not be satisfied by `OrderTest`.
  test("matching is whole-word, so a prefix does not satisfy the claim", async () => {
    const dir = project(
      { "test/order.test.ts": "test('OrderServiceTest', () => {});" },
      req("live", ["Order"]),
    );
    const d = checkVerifiedBy(await load(dir), dir);
    expect(d).toHaveLength(1);
    expect(d[0]!.code).toBe(ERR_REQUIREMENT_TEST_MISSING);
  });

  test("no @verifiedBy anywhere is silent (opt-in by declaration)", async () => {
    const dir = project({ "test/order.test.ts": "test('x', () => {});" }, req("live", []));
    expect(checkVerifiedBy(await load(dir), dir)).toEqual([]);
  });

  test("node_modules is not scanned", async () => {
    const dir = project(
      { "node_modules/pkg/index.test.ts": "test('OrderServiceTest', () => {});" },
      req("live", ["OrderServiceTest"]),
    );
    // the only 'test file' is inside node_modules -> corpus empty -> fail open
    expect(checkVerifiedBy(await load(dir), dir)).toEqual([]);
  });
});

// The audit that prompted this: a claim named `mountCrudRoutes`, whose only occurrence
// in an entire corpus was inside a comment. The scan reported it found and said nothing.
describe("a name found only in a comment is reported, not accepted", () => {
  test("comment-only match → WARN; never a silent pass, and never an error", async () => {
    const dir = project(
      {
        "test/order.test.ts": [
          "// via mountCrudRoutes({ expose: ['list'] }) directly",
          "test('something else', () => {});",
        ].join("\n"),
      },
      req("live", ["mountCrudRoutes"]),
    );
    const d = checkVerifiedBy(await load(dir), dir);
    expect(d).toHaveLength(1);
    expect(d[0]!.code).toBe(WARN_REQUIREMENT_TEST_COMMENT_ONLY);
    expect(d[0]!.severity).toBe("warn");
    expect(d[0]!.message).toContain("order.test.ts:1");
  });

  test("a name in BOTH a comment and a real declaration still passes clean", async () => {
    const dir = project(
      {
        "test/order.test.ts": [
          "// see OrderServiceTest below",
          "describe('OrderServiceTest', () => {});",
        ].join("\n"),
      },
      req("live", ["OrderServiceTest"]),
    );
    expect(checkVerifiedBy(await load(dir), dir)).toEqual([]);
  });

  // Stripping from the first `//` would truncate this line and lose a real match —
  // which is why the rule is whole-line-is-a-comment, not strip-to-EOL.
  test("a URL inside a test title is code, not a comment", async () => {
    const dir = project(
      { "test/order.test.ts": "test('rejects https://evil.example for OrderServiceTest', () => {});" },
      req("live", ["OrderServiceTest"]),
    );
    expect(checkVerifiedBy(await load(dir), dir)).toEqual([]);
  });

  test("a JSDoc continuation line is a comment too", async () => {
    const dir = project(
      {
        "test/order.test.ts": ["/**", " * OrderServiceTest covers this.", " */", "test('other', () => {});"].join("\n"),
      },
      req("live", ["OrderServiceTest"]),
    );
    const d = checkVerifiedBy(await load(dir), dir);
    expect(d[0]!.code).toBe(WARN_REQUIREMENT_TEST_COMMENT_ONLY);
  });
});
