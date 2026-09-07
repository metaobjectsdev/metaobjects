/**
 * #333 — a project opts into a MetaObjects-shipped library with `libraries` in
 * `metaobjects.config.ts`, and `extends: "metaobjects::ai::LlmCallBase"` resolves.
 *
 * `librarySources` was reachable only from `MetaDataLoader.fromDirectory`, which the CLI
 * does not use, so a generator that consumes a library was registered FOR the command
 * line while its input was unreachable THROUGH it. An adopter following the documented
 * `extends` path got `ERR_UNRESOLVED_SUPER` pointing at their own metadata.
 *
 * The NEGATIVE arm is the half that proves the opt-in is doing the work: without the key
 * the same model must still fail to load. A test that only asserts the positive keeps
 * passing if `libraries` is quietly made unconditional, which would put library nodes
 * into the model — and the generated output, and the docs — of every project that never
 * asked for one.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

/** An entity extending the shipped `metaobjects::ai::LlmCallBase`. */
const MODEL = JSON.stringify({
  "metadata.root": {
    package: "acme::trace",
    children: [
      {
        "object.entity": {
          name: "AgentCall",
          extends: "metaobjects::ai::LlmCallBase",
          children: [
            { "source.rdb": { "@table": "agent_call" } },
            { "identity.primary": { name: "pk", "@fields": ["spanId"] } },
          ],
        },
      },
    ],
  },
});

function setup(libraries: string[] | undefined): { root: string; outDir: string } {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "forge-libraries-"));
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "trace.json"), MODEL, "utf8");
  const outDir = join(root, "generated");
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(outDir)},
  dialect: "postgres",
  dbImport: "~/db",
  extStyle: "none",
${libraries === undefined ? "" : `  libraries: ${JSON.stringify(libraries)},\n`}  generators: ["entity"],
});
`,
  );
  return { root, outDir };
}

describe("meta gen — libraries (#333)", () => {
  test("`libraries: [\"ai\"]` makes a shipped library base resolvable", async () => {
    const { root, outDir } = setup(["ai"]);
    try {
      const exit = await run(["gen", "--cwd", root]);
      expect(exit).toBe(0);
      expect(existsSync(join(outDir, "AgentCall.ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without the opt-in the same model does NOT load — the key is doing the work", async () => {
    const { root, outDir } = setup(undefined);
    try {
      const exit = await run(["gen", "--cwd", root]);
      expect(exit).not.toBe(0);
      expect(existsSync(join(outDir, "AgentCall.ts"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unknown library name is refused by name, with the available ones listed", async () => {
    const { root } = setup(["nosuchlib"]);
    try {
      // Hard config error rather than a silent skip: skipped, it resurfaces later as
      // ERR_UNRESOLVED_SUPER against the adopter's own metadata — the wrong place to look.
      const exit = await run(["gen", "--cwd", root]);
      expect(exit).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
