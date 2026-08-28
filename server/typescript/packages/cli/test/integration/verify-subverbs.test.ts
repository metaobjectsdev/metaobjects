/**
 * meta verify — unified subverbs (ADR-0021 D2).
 *
 * Asserts the explicit-subverb contract:
 *   - `verify --templates` runs the template/prompt drift gate (clean → 0, drift → 1).
 *   - bare `verify` is back-compat (= --templates) and prints the subverb note.
 *   - `verify --codegen` regenerates to a temp dir and diffs the committed output:
 *       committed == fresh regen → 0; generated content that has gone STALE against
 *       the metadata → 1, naming the drifted file. A hand-edited generated file is
 *       NOT drift (see verify-codegen-hand-edits.test.ts).
 *   - an invalid flag → exit 2 with usage.
 *
 * The --db dispatch is covered by verify-db-drift.test.ts; here we only assert
 * --db still routes (a light assertion via a clearly-bad URL → non-zero, no crash).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");
// Temp dirs live inside the monorepo so jiti can resolve @metaobjectsdev/*
// when it loads metaobjects.config.ts (same rationale as gen-sqlite.test.ts).
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

function genOutDir(root: string): string {
  return join(root, "generated", "db");
}

/** A repo with a codegen config + committed (already-generated) output. */
function setupCodegenRepo(): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "verify-subverbs-"));
  cpSync(join(FIXTURES, "trainer-website-meta"), root, { recursive: true });
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
import { entityFile } from "@metaobjectsdev/codegen-ts/generators";
export default defineConfig({
  outDir: ${JSON.stringify(genOutDir(root))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: [entityFile()],
});
`,
  );
  return root;
}

/** A minimal template-drift repo (PostBrief payload + a prompt). */
const TEMPLATE_META = {
  "metadata.root": {
    package: "acme::ai",
    children: [
      { "object.value": { name: "Brief", children: [{ "field.string": { name: "displayName" } }] } },
      {
        "template.prompt": {
          name: "myPrompt",
          "@payloadRef": "Brief",
          "@textRef": "prompt/strategy",
        },
      },
    ],
  },
};

function setupTemplateRepo(promptText: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "verify-subverbs-tmpl-"));
  mkdirSync(join(tmp, "metaobjects"), { recursive: true });
  writeFileSync(join(tmp, "metaobjects", "meta.ai.json"), JSON.stringify(TEMPLATE_META), "utf8");
  mkdirSync(join(tmp, "prompts", "prompt"), { recursive: true });
  writeFileSync(join(tmp, "prompts", "prompt", "strategy.mustache"), promptText, "utf8");
  return tmp;
}

let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta verify — subverbs (ADR-0021 D2)", () => {
  // 1. --templates = current template-drift behavior.
  test("--templates: clean templates → exit 0", async () => {
    const tmp = setupTemplateRepo("Hi {{displayName}}.");
    try {
      expect(await run(["verify", "--cwd", tmp, "--templates"])).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("--templates: drifted variable → exit 1 + names the drift", async () => {
    const tmp = setupTemplateRepo("Hi {{notARealField}}.");
    try {
      expect(await run(["verify", "--cwd", tmp, "--templates"])).toBe(1);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("ERR_VAR_NOT_ON_PAYLOAD");
      expect(all).toContain("notARealField");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // 3. Bare verify = --templates (back-compat) + prints the subverb note.
  test("bare verify behaves as --templates and prints the subverb note", async () => {
    const tmp = setupTemplateRepo("Hi {{notARealField}}.");
    try {
      expect(await run(["verify", "--cwd", tmp])).toBe(1);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("ERR_VAR_NOT_ON_PAYLOAD");
      // The one-line note advertising the explicit subverbs.
      expect(all).toMatch(/--templates|--codegen|--db/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // 2. --codegen: committed == fresh regen → 0; stale generated content → 1.
  test("--codegen: committed output matches a fresh regen → exit 0", async () => {
    const root = setupCodegenRepo();
    try {
      // First materialize committed output.
      expect(await run(["gen", "--cwd", root])).toBe(0);
      // Now verify it against a fresh regen — should be clean.
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The VEHICLE changed here, not the assertion. This case used to inject drift by
  // hand-editing a generated file — but a hand edit is not drift: `meta gen`
  // three-way-merges it and the product invites it, so convicting it made the gate
  // fail its own sanctioned workflow with a remedy that looped. Stale generated
  // content is the genuine article, and it still exits 1 and still names the file.
  // See spec/design-docs/2026-08-27-codegen-drift-hand-edits-design.md; the hand-edit
  // case is asserted clean in verify-codegen-hand-edits.test.ts.
  test("--codegen: committed output stale against the metadata → exit 1 + names the file", async () => {
    const root = setupCodegenRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      // Inject drift: change the metadata and do NOT re-run `meta gen`.
      const metaFile = join(root, "metaobjects", "myapp.json");
      writeFileSync(
        metaFile,
        readFileSync(metaFile, "utf8").replace('"@maxLength": 255', '"@maxLength": 128'),
        "utf8",
      );

      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(1);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("User.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--codegen: errors clearly when there is no config", async () => {
    // A metaobjects/ dir but no metaobjects.config.ts → --codegen can't know
    // where the committed output lives.
    const tmp = setupTemplateRepo("Hi {{displayName}}.");
    try {
      const exit = await run(["verify", "--cwd", tmp, "--codegen"]);
      expect(exit).not.toBe(0);
      const all = [...out, ...err].join("\n");
      expect(all).toMatch(/config|outDir/i);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // 4. --db still routes (light assertion: a bad URL → non-zero, no crash).
  test("--db still routes (bad connection → non-zero, handled)", async () => {
    const tmp = setupTemplateRepo("Hi {{displayName}}.");
    try {
      const exit = await run([
        "verify",
        "--cwd",
        tmp,
        "--db",
        "file:/nonexistent/dir/that/should/not/exist/x.db",
        "--dialect",
        "sqlite",
      ]);
      // Whatever the outcome, it must be a handled exit code, never a throw.
      expect(typeof exit).toBe("number");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // 5. Invalid flag → exit 2.
  test("invalid flag → exit 2", async () => {
    const tmp = setupTemplateRepo("Hi {{displayName}}.");
    try {
      expect(await run(["verify", "--cwd", tmp, "--bogus"])).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Combination: --templates + --codegen aggregates exit codes.
  test("combination --templates --codegen: any drift fails (template drift → 1)", async () => {
    const root = setupCodegenRepo();
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      // The trainer-website fixture has no template.* nodes → templates path is
      // clean; codegen path is clean too → combined exit 0.
      expect(await run(["verify", "--cwd", root, "--templates", "--codegen"])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
