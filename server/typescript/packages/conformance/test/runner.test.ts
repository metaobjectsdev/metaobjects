import { test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixture } from "../src/runner.js";
import { discoverFixtures } from "../src/fixture.js";
import type { ConformanceAdapter } from "../src/adapter.js";
import { UnknownCapabilityError } from "../src/adapter.js";

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

// A fake adapter: the tree is the parsed input; serialization is JSON.stringify.
const fake: ConformanceAdapter = {
  language: "fake",
  async loadFixture() { return { tree: { ok: true }, errorCodes: [], warnings: [] }; },
  canonicalSerialize() { return '{"ok":true}'; },
  canonicalSerializeEffective() { return '{"ok":true}'; },
  navigate() { return { node: true }; },
  invoke() { return { scalar: true }; },
};

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mo-run-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, "fix", path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

// ── original 3 tests ────────────────────────────────────────────────────────

test("a matching expected.json check passes", async () => {
  const root = await fixture({ "input/m.json": "{}", "expected.json": '{"ok":true}' });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, fake);
  expect(report.status).toBe("pass");
  expect(report.checks[0]!.passed).toBe(true);
});

test("a mismatching expected.json check fails", async () => {
  const root = await fixture({ "input/m.json": "{}", "expected.json": '{"ok":false}' });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, fake);
  expect(report.status).toBe("fail");
});

test("an operation check compares the normalized result", async () => {
  const root = await fixture({
    "input/m.json": "{}",
    "script.json": JSON.stringify({
      operations: [{ navigate: ["object:X"], invoke: "x.y", expect: { scalar: true } }],
    }),
  });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, fake);
  expect(report.status).toBe("pass");
  expect(report.capabilities).toEqual(["x.y"]);
});

// ── Fix 2: expected-errors ───────────────────────────────────────────────────

test("expected-errors: matching error codes → pass, no detail", async () => {
  const errorsAdapter: ConformanceAdapter = {
    ...fake,
    async loadFixture() { return { tree: undefined, errorCodes: ["ERR_UNKNOWN_TYPE"], warnings: [] }; },
  };
  const root = await fixture({
    "input/m.json": "{}",
    "expected-errors.json": JSON.stringify([{ code: "ERR_UNKNOWN_TYPE" }]),
  });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, errorsAdapter);
  expect(report.status).toBe("pass");
  const check = report.checks.find((c) => c.kind === "expected-errors")!;
  expect(check.passed).toBe(true);
  expect(check.detail).toBeUndefined();
});

test("expected-errors: mismatching error codes → fail with detail", async () => {
  const errorsAdapter: ConformanceAdapter = {
    ...fake,
    async loadFixture() { return { tree: undefined, errorCodes: ["ERR_WRONG"], warnings: [] }; },
  };
  const root = await fixture({
    "input/m.json": "{}",
    "expected-errors.json": JSON.stringify([{ code: "ERR_UNKNOWN_TYPE" }]),
  });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, errorsAdapter);
  expect(report.status).toBe("fail");
  const check = report.checks.find((c) => c.kind === "expected-errors")!;
  expect(check.passed).toBe(false);
  expect(check.detail).toContain("ERR_UNKNOWN_TYPE");
  expect(check.detail).toContain("ERR_WRONG");
});

// ── expected-effective path ──────────────────────────────────────────────────

test("expected-effective: matching serialization → pass", async () => {
  const root = await fixture({
    "input/m.json": "{}",
    "expected-effective.json": '{"ok":true}',
  });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, fake);
  expect(report.status).toBe("pass");
  const check = report.checks.find((c) => c.kind === "expected-effective")!;
  expect(check.passed).toBe(true);
});

// ── navigate returning undefined ─────────────────────────────────────────────

test("navigate returning undefined → operation check fails with 'did not resolve'", async () => {
  const noNavAdapter: ConformanceAdapter = {
    ...fake,
    navigate() { return undefined; },
  };
  const root = await fixture({
    "input/m.json": "{}",
    "script.json": JSON.stringify({
      operations: [{ navigate: ["object:Missing"], invoke: "x.y", expect: { scalar: true } }],
    }),
  });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, noNavAdapter);
  expect(report.status).toBe("fail");
  const check = report.checks.find((c) => c.kind === "operation")!;
  expect(check.passed).toBe(false);
  expect(check.detail).toContain("did not resolve");
});

// ── invoke throwing UnknownCapabilityError ───────────────────────────────────

test("invoke throwing UnknownCapabilityError → fails with 'unbound capability'", async () => {
  const unknownCapAdapter: ConformanceAdapter = {
    ...fake,
    invoke(_node, capId) { throw new UnknownCapabilityError(capId); },
  };
  const root = await fixture({
    "input/m.json": "{}",
    "script.json": JSON.stringify({
      operations: [{ navigate: ["object:X"], invoke: "no.such-cap", expect: { scalar: true } }],
    }),
  });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, unknownCapAdapter);
  expect(report.status).toBe("fail");
  const check = report.checks.find((c) => c.kind === "operation")!;
  expect(check.passed).toBe(false);
  expect(check.detail).toContain("unbound capability");
});

// ── Fix 1: load-failure synthetic check ─────────────────────────────────────

test("load failure on a tree-expecting fixture → synthetic 'load produced no tree' check", async () => {
  const failAdapter: ConformanceAdapter = {
    ...fake,
    async loadFixture() { return { errorCodes: [], warnings: [] }; },
  };
  const root = await fixture({
    "input/m.json": "{}",
    "expected.json": '{"ok":true}',
  });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, failAdapter);
  expect(report.status).toBe("fail");
  const synthetic = report.checks.find(
    (c) => c.kind === "expected" && c.detail?.includes("load produced no tree"),
  );
  expect(synthetic).toBeDefined();
  expect(synthetic!.passed).toBe(false);
});

// ── Fix 1: zero-expectation fixture ──────────────────────────────────────────

test("fixture with no expectation files → one failed check with 'declares no expectation files'", async () => {
  const root = await fixture({ "input/m.json": "{}" });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, fake);
  expect(report.status).toBe("fail");
  expect(report.checks).toHaveLength(1);
  expect(report.checks[0]!.passed).toBe(false);
  expect(report.checks[0]!.detail).toContain("declares no expectation files");
});

// ── Fix 2: malformed fixture files produce failed checks, not throws ──────────

test("malformed expected-errors.json (object not array) → failed check, no throw", async () => {
  const root = await fixture({
    "input/m.json": "{}",
    "expected-errors.json": '{"code":"ERR_UNKNOWN_TYPE"}',
  });
  const [fix] = await discoverFixtures(root);
  // runFixture must not throw
  const report = await runFixture(fix!, fake);
  expect(report.status).toBe("fail");
  const errCheck = report.checks.find((c) => c.kind === "expected-errors");
  expect(errCheck).toBeDefined();
  expect(errCheck!.passed).toBe(false);
  expect(errCheck!.detail).toMatch(/parse error/);
});

test("malformed script.json (bad JSON) → failed check, no throw", async () => {
  const root = await fixture({
    "input/m.json": "{}",
    "script.json": "not-valid-json{{{",
  });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, fake);
  expect(report.status).toBe("fail");
  const errCheck = report.checks.find((c) => c.kind === "operation");
  expect(errCheck).toBeDefined();
  expect(errCheck!.passed).toBe(false);
  expect(errCheck!.detail).toMatch(/parse error/);
});

// ── FR5c-finalize — warning envelope-shape assertion ────────────────────────

test("expected-errors warnings: matching envelope shape → pass", async () => {
  const warnAdapter: ConformanceAdapter = {
    ...fake,
    async loadFixture() {
      return {
        tree: { ok: true },
        errorCodes: [],
        warnings: ["dup decl"],
        warningEnvelopes: [{
          code: "WARN_DUPLICATE_DECLARATION",
          source: { format: "merged", files: ["meta.a.json", "meta.b.json"] },
        }],
      };
    },
  };
  const root = await fixture({
    "input/m.json": "{}",
    "expected.json": '{"ok":true}',
    "expected-errors.json": JSON.stringify({
      errors: [],
      warnings: [{
        code: "WARN_DUPLICATE_DECLARATION",
        source: { format: "merged", files: ["meta.a.json", "meta.b.json"] },
      }],
    }),
  });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, warnAdapter);
  expect(report.status).toBe("pass");
});

test("expected-errors warnings: mismatched code → fail with warning[i].code detail", async () => {
  const warnAdapter: ConformanceAdapter = {
    ...fake,
    async loadFixture() {
      return {
        tree: { ok: true },
        errorCodes: [],
        warnings: ["something else"],
        warningEnvelopes: [{
          code: "WARN_SOMETHING_ELSE",
          source: { format: "merged", files: ["meta.a.json"] },
        }],
      };
    },
  };
  const root = await fixture({
    "input/m.json": "{}",
    "expected.json": '{"ok":true}',
    "expected-errors.json": JSON.stringify({
      errors: [],
      warnings: [{
        code: "WARN_DUPLICATE_DECLARATION",
        source: { format: "merged", files: ["meta.a.json"] },
      }],
    }),
  });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, warnAdapter);
  expect(report.status).toBe("fail");
  const detail = report.checks.filter((c) => !c.passed).map((c) => c.detail).join("; ");
  expect(detail).toMatch(/warning\[0\]\.code/);
});

test("expected-errors warnings: mismatched files → fail with warning[i].source.files detail", async () => {
  const warnAdapter: ConformanceAdapter = {
    ...fake,
    async loadFixture() {
      return {
        tree: { ok: true },
        errorCodes: [],
        warnings: ["dup decl"],
        warningEnvelopes: [{
          code: "WARN_DUPLICATE_DECLARATION",
          source: { format: "merged", files: ["meta.a.json", "meta.c.json"] },
        }],
      };
    },
  };
  const root = await fixture({
    "input/m.json": "{}",
    "expected.json": '{"ok":true}',
    "expected-errors.json": JSON.stringify({
      errors: [],
      warnings: [{
        code: "WARN_DUPLICATE_DECLARATION",
        source: { format: "merged", files: ["meta.a.json", "meta.b.json"] },
      }],
    }),
  });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, warnAdapter);
  expect(report.status).toBe("fail");
  const detail = report.checks.filter((c) => !c.passed).map((c) => c.detail).join("; ");
  expect(detail).toMatch(/warning\[0\]\.source\.files/);
});

test("expected-errors warnings: count mismatch → fail with warnings count detail", async () => {
  const warnAdapter: ConformanceAdapter = {
    ...fake,
    async loadFixture() {
      return {
        tree: { ok: true },
        errorCodes: [],
        warnings: ["only one"],
        warningEnvelopes: [{
          code: "WARN_DUPLICATE_DECLARATION",
          source: { format: "merged", files: ["meta.a.json"] },
        }],
      };
    },
  };
  const root = await fixture({
    "input/m.json": "{}",
    "expected.json": '{"ok":true}',
    "expected-errors.json": JSON.stringify({
      errors: [],
      warnings: [
        { code: "WARN_DUPLICATE_DECLARATION", source: { format: "merged", files: ["meta.a.json"] } },
        { code: "WARN_DUPLICATE_DECLARATION", source: { format: "merged", files: ["meta.a.json"] } },
      ],
    }),
  });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, warnAdapter);
  expect(report.status).toBe("fail");
  const detail = report.checks.filter((c) => !c.passed).map((c) => c.detail).join("; ");
  expect(detail).toMatch(/warnings count: expected 2, got 1/);
});
