// `meta gen` says so when the model declares requirements and (a) no generator writes their
// tests, or (b) the scaffolded agent context has no requirements pages. Both are advisories:
// the exit code never changes.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

const TIMEOUT_MS = 30_000;

const ENTITY_JSON = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [{
      "object.entity": {
        name: "Order",
        children: [
          { "source.rdb": { name: "src", "@table": "orders" } },
          { "field.string": { name: "id" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "uuid" } },
        ],
      },
    }],
  },
});

const REQUIREMENTS_JSON = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [{
      "requirement.functional": {
        name: "placeOrder",
        "@level": 4,
        "@status": "planned",
        "@statement": "A customer can place an order.",
        "@counterexample": "An order cannot be placed.",
      },
    }],
  },
});

function project(opts: { requirements: boolean; generators: string; agentContextFiles?: string[] }): string {
  const dir = mkdtempSync(join(tmpdir(), "mo-gen-req-"));
  mkdirSync(join(dir, "metaobjects"), { recursive: true });
  mkdirSync(join(dir, ".metaobjects"), { recursive: true });
  writeFileSync(join(dir, "metaobjects", "meta.shop.json"), ENTITY_JSON);
  if (opts.requirements) writeFileSync(join(dir, "metaobjects", "meta.requirements.json"), REQUIREMENTS_JSON);
  writeFileSync(join(dir, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }));
  if (opts.agentContextFiles !== undefined) {
    writeFileSync(
      join(dir, ".metaobjects", ".agent-context.json"),
      JSON.stringify({
        version: 1, servers: ["typescript"], clients: [],
        files: Object.fromEntries(opts.agentContextFiles.map((p) => [p, "h"])),
      }),
    );
  }
  writeFileSync(
    join(dir, "metaobjects.config.ts"),
    `import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(join(dir, "generated"))},
  dialect: "sqlite",
  extStyle: "js",
  generators: ${opts.generators},
});
`,
  );
  return dir;
}

async function gen(dir: string): Promise<{ exit: number; err: string }> {
  const errLines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = (...a: unknown[]) => { errLines.push(a.map(String).join(" ")); };
  try {
    return { exit: await run(["gen", "--cwd", dir, "--format", "text"]), err: errLines.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("meta gen requirement advisories", () => {
  test("requirements and no requirement-tests generator → names requirementTests(); exit unchanged", async () => {
    const dir = project({ requirements: true, generators: `["entity"]` });
    try {
      const { exit, err } = await gen(dir);
      expect(exit).toBe(0);
      expect(err).toContain("declares 1 requirement and no generator writes their tests");
      expect(err).toContain("requirementTests()");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, TIMEOUT_MS);

  test("silent once requirement-tests is wired, and silent with no requirements", async () => {
    const wired = project({ requirements: true, generators: `["entity", "requirement-tests"]` });
    const none = project({ requirements: false, generators: `["entity"]` });
    try {
      expect((await gen(wired)).err).not.toContain("no generator writes their tests");
      expect((await gen(none)).err).not.toContain("no generator writes their tests");
    } finally {
      rmSync(wired, { recursive: true, force: true });
      rmSync(none, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("agent context scaffolded without the requirements pages → names the refresh", async () => {
    const missing = project({
      requirements: true, generators: `["entity"]`,
      agentContextFiles: [".metaobjects/AGENTS.md", ".claude/skills/metaobjects-authoring/SKILL.md"],
    });
    const present = project({
      requirements: true, generators: `["entity"]`,
      agentContextFiles: [
        ".claude/skills/metaobjects-authoring/SKILL.md",
        ".claude/skills/metaobjects-authoring/references/requirements.md",
      ],
    });
    try {
      const a = await gen(missing);
      expect(a.exit).toBe(0);
      expect(a.err).toContain("without its requirements pages");
      expect(a.err).toContain("meta init --docs-only --refresh-docs");
      expect((await gen(present)).err).not.toContain("without its requirements pages");
    } finally {
      rmSync(missing, { recursive: true, force: true });
      rmSync(present, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
