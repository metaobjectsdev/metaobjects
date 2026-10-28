/**
 * A bare `meta verify` runs the cross-port default gate set — codegen drift, prompt
 * templates, the requirement ledger — so "run `meta verify` in CI" catches a model that
 * changed without `meta gen` being re-run. `--db`, `--deps` and `--replay` stay opt-in; a
 * project with no `metaobjects.config.ts` has nothing generated to diff, so the codegen
 * gate is skipped with a note rather than failed. Naming a gate still runs only that gate.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

const entity = (extra: unknown[] = []): string => JSON.stringify({
  "metadata.root": {
    package: "app",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { name: "id" } },
            ...extra,
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

function setupRepo(opts: { withConfig: boolean }): string {
  const root = mkdtempSync(join(tmpdir(), "verify-bare-default-"));
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.app.json"), entity(), "utf8");
  if (opts.withConfig) {
    writeFileSync(
      join(root, "metaobjects.config.ts"),
      `import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(join(root, "generated", "db"))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: ["entity"],
});
`,
    );
  }
  return root;
}

/** Change the model after `meta gen`, leaving the generated output stale. */
function staleTheModel(root: string): void {
  writeFileSync(
    join(root, "metaobjects", "meta.app.json"),
    entity([{ "field.string": { name: "note" } }]),
    "utf8",
  );
}

let out: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;
beforeEach(() => {
  out = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta verify — the bare run's default gate set", () => {
  test("bare verify fails on stale generated code", async () => {
    const root = setupRepo({ withConfig: true });
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect(await run(["verify", "--cwd", root])).toBe(0);
      staleTheModel(root);
      out = [];
      expect(await run(["verify", "--cwd", root])).toBe(1);
      expect(out.join("\n")).toContain("Order.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("naming --templates still runs only the template gate", async () => {
    const root = setupRepo({ withConfig: true });
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      staleTheModel(root);
      expect(await run(["verify", "--cwd", root, "--templates"])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a bare run with no metaobjects.config.ts skips codegen with a note and passes", async () => {
    const root = setupRepo({ withConfig: false });
    try {
      expect(await run(["verify", "--cwd", root])).toBe(0);
      expect(out.join("\n")).toContain("codegen gate skipped: no metaobjects.config.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a bare run with a metaobjects.config.ts that fails to load exits 2 with the load error", async () => {
    const root = setupRepo({ withConfig: false });
    try {
      writeFileSync(join(root, "metaobjects.config.ts"), `export default { this is not valid typescript`, "utf8");
      expect(await run(["verify", "--cwd", root])).toBe(2);
      expect(out.join("\n")).toContain("failed to load");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
