// `meta fmt` (#304) — integration tests driven through the real CLI entry
// point (`run`), mirroring the other commands' integration tests.
import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

function withTmp(fixture: string, fn: (tmp: string) => Promise<void> | void) {
  return async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-fmt-"));
    cpSync(join(FIXTURES, fixture), tmp, { recursive: true });
    try {
      await fn(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

const BASE = (tmp: string) => join(tmp, "metaobjects/meta.base.json");
const OVERLAY = (tmp: string) => join(tmp, "metaobjects/meta.widget.ui.json");
const CANONICAL = (tmp: string) => join(tmp, "metaobjects/meta.already-canonical.json");
const YAML = (tmp: string) => join(tmp, "metaobjects/meta.extra.yaml");

describe("meta fmt", () => {
  test(
    "reformats a messy file, leaves an already-canonical file untouched, skips overlay and yaml",
    withTmp("fmt-messy", async (tmp) => {
      const beforeCanonical = readFileSync(CANONICAL(tmp), "utf8");
      const beforeOverlay = readFileSync(OVERLAY(tmp), "utf8");
      const beforeYaml = readFileSync(YAML(tmp), "utf8");
      const beforeBase = readFileSync(BASE(tmp), "utf8");

      const exit = await run(["fmt", "--cwd", tmp]);
      expect(exit).toBe(0);

      const afterBase = readFileSync(BASE(tmp), "utf8");
      expect(afterBase).not.toBe(beforeBase);
      // Canonical: 2-space indent, name before @description, scalar @fields → array.
      expect(afterBase).toBe(
        JSON.stringify(
          {
            "metadata.root": {
              package: "acme",
              children: [
                {
                  "object.entity": {
                    name: "Widget",
                    "@description": "A widget",
                    children: [
                      { "field.string": { name: "sku", "@maxLength": 40, "@required": true } },
                      { "field.string": { name: "name" } },
                      { "identity.secondary": { name: "bySku", "@fields": ["sku"] } },
                    ],
                  },
                },
              ],
            },
          },
          null,
          2,
        ) + "\n",
      );

      expect(readFileSync(CANONICAL(tmp), "utf8")).toBe(beforeCanonical);
      expect(readFileSync(OVERLAY(tmp), "utf8")).toBe(beforeOverlay);
      expect(readFileSync(YAML(tmp), "utf8")).toBe(beforeYaml);
    }),
  );

  test(
    "is idempotent — a second run changes nothing further",
    withTmp("fmt-messy", async (tmp) => {
      expect(await run(["fmt", "--cwd", tmp])).toBe(0);
      const once = readFileSync(BASE(tmp), "utf8");
      expect(await run(["fmt", "--cwd", tmp])).toBe(0);
      expect(readFileSync(BASE(tmp), "utf8")).toBe(once);
    }),
  );

  test(
    "--check lists non-canonical files, exits non-zero, and changes nothing",
    withTmp("fmt-messy", async (tmp) => {
      const before = readFileSync(BASE(tmp), "utf8");
      const exit = await run(["fmt", "--check", "--cwd", tmp]);
      expect(exit).toBe(1);
      expect(readFileSync(BASE(tmp), "utf8")).toBe(before);
    }),
  );

  test(
    "--check exits 0 once the project is already canonical",
    withTmp("fmt-messy", async (tmp) => {
      expect(await run(["fmt", "--cwd", tmp])).toBe(0);
      expect(await run(["fmt", "--check", "--cwd", tmp])).toBe(0);
    }),
  );

  test(
    "an explicit file argument narrows the run to that file",
    withTmp("fmt-messy", async (tmp) => {
      const beforeBase = readFileSync(BASE(tmp), "utf8");
      const exit = await run(["fmt", "--cwd", tmp, "metaobjects/meta.already-canonical.json"]);
      expect(exit).toBe(0);
      // Untouched — only the named file was in scope, and it was already canonical.
      expect(readFileSync(BASE(tmp), "utf8")).toBe(beforeBase);
    }),
  );

  test(
    "an explicit file argument outside the resolved sources is a fatal, non-zero error",
    withTmp("fmt-messy", async (tmp) => {
      writeFileSync(join(tmp, "outside.json"), "{}");
      const exit = await run(["fmt", "--cwd", tmp, "outside.json"]);
      expect(exit).toBe(1);
    }),
  );

  test(
    "refuses to run at all when the project does not currently load cleanly",
    withTmp("invalid-json", async (tmp) => {
      const before = readFileSync(join(tmp, "metaobjects/bad.json"), "utf8");
      const exit = await run(["fmt", "--cwd", tmp]);
      expect(exit).toBe(1);
      expect(readFileSync(join(tmp, "metaobjects/bad.json"), "utf8")).toBe(before);
    }),
  );
});
