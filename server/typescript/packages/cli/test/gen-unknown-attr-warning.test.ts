// `meta gen` loads leniently, `meta verify` strictly (ADR-0023). An unknown attribute —
// a bare `isAbstrakt: true` meant as `abstract`, a misspelt `@requird` — used to pass
// `gen` without a word while `verify` rejected the same file with ERR_UNKNOWN_ATTR, and
// the typo silently changed the output (the "abstract" base got a table of its own).
// `gen` now names each finding — attribute, node and file — as a warning, and keeps its
// exit code.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../src/index.js";
import { ejectCommand } from "../src/commands/eject.js";
import { FINGERPRINT_FILE } from "../src/lib/gen-fingerprint.js";

const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures", "__tmp__");

function model(opts: { typos: boolean; bareTypo?: boolean }): string {
  return JSON.stringify({
    "metadata.root": {
      package: "app",
      children: [
        {
          "object.entity": {
            name: "BaseThing",
            ...(opts.typos ? { isAbstrakt: true } : { abstract: true }),
            ...(opts.bareTypo === true ? { isAbstrakt: true } : {}),
            children: [{ "field.long": { name: "id" } }],
          },
        },
        {
          "object.entity": {
            name: "Talk",
            extends: "BaseThing",
            children: [
              { "source.rdb": { "@table": "talks" } },
              { "field.string": { name: "title", ...(opts.typos ? { "@requird": true } : { "@required": true }) } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
      ],
    },
  });
}

function setupRepo(opts: { typos: boolean }): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "gen-unknown-attr-"));
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.app.json"), model(opts), "utf8");
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }), "utf8");
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(join(root, "generated"))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: ["entity"],
});
`,
  );
  return root;
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

describe("meta gen — unknown attributes are warned about, not swallowed", () => {
  test("each unknown attribute is named with its node and file; exit code unchanged", async () => {
    const root = setupRepo({ typos: true });
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      const stderr = err.join("\n");
      expect(stderr).toContain("ERR_UNKNOWN_ATTR");
      expect(stderr).toContain("isAbstrakt");
      expect(stderr).toContain("BaseThing");
      expect(stderr).toContain("@requird");
      expect(stderr).toContain("title");
      expect(stderr).toContain("meta.app.json");
      expect(stderr).toContain("meta verify");
      // Printed relative to the project, never as the machine's absolute path.
      expect(stderr).not.toContain(join(root, "metaobjects"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the structured output carries the same warnings", async () => {
    const root = setupRepo({ typos: true });
    try {
      expect(await run(["gen", "--cwd", root, "--format", "json"])).toBe(0);
      const payload = JSON.parse(out.join("\n")) as { warnings?: string[] };
      expect(payload.warnings?.some((w) => w.includes("@requird"))).toBe(true);
      expect(payload.warnings?.some((w) => w.includes("isAbstrakt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a clean model prints no unknown-attribute warning", async () => {
    const root = setupRepo({ typos: false });
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect(err.join("\n")).not.toContain("ERR_UNKNOWN_ATTR");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("meta gen --strict — an unknown attribute is an error", () => {
  test("fails with the strict load's error and writes nothing", async () => {
    const root = setupRepo({ typos: true });
    try {
      expect(await run(["gen", "--strict", "--cwd", root])).toBe(1);
      const stderr = err.join("\n");
      expect(stderr).toContain("ERR_UNKNOWN_ATTR");
      expect(stderr).toContain("--strict");
      expect(existsSync(join(root, "generated"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a clean model generates exactly as without it", async () => {
    const root = setupRepo({ typos: false });
    try {
      expect(await run(["gen", "--strict", "--cwd", root])).toBe(0);
      expect(existsSync(join(root, "generated"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without it the same model still generates, with the warning", async () => {
    const root = setupRepo({ typos: true });
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect(existsSync(join(root, "generated"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("meta gen — a run that skips still names the unknown attribute (ADR-0064 × ADR-0023)", () => {
  test("a bare typo'd key the lenient load drops leaves the stored key matched: warn, then skip", async () => {
    const root = setupRepo({ typos: false });
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      const stateFile = join(root, ".metaobjects", ".gen-state", FINGERPRINT_FILE);
      expect(existsSync(stateFile)).toBe(true);
      const stored = readFileSync(stateFile, "utf8");
      // A bare typo'd key: the lenient load drops it (a warning, never a tree
      // change), so the loaded model — and the skip key made of it — is unchanged.
      writeFileSync(join(root, "metaobjects", "meta.app.json"), model({ typos: false, bareTypo: true }), "utf8");
      out = [];
      err = [];
      expect(await run(["gen", "--cwd", root])).toBe(0);
      // The run skipped: its summary says so, and nothing the last run recorded —
      // the stored key included — was rewritten.
      expect(out.join("\n")).toContain("nothing changed since the last meta gen");
      expect(readFileSync(stateFile, "utf8")).toBe(stored);
      // And the typo is still named, with the verify advice.
      const stderr = err.join("\n");
      expect(stderr).toContain("ERR_UNKNOWN_ATTR");
      expect(stderr).toContain("isAbstrakt");
      expect(stderr).toContain("meta verify");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the skipped structured document carries the same warning", async () => {
    const root = setupRepo({ typos: false });
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      writeFileSync(join(root, "metaobjects", "meta.app.json"), model({ typos: false, bareTypo: true }), "utf8");
      out = [];
      err = [];
      expect(await run(["gen", "--cwd", root, "--format", "json"])).toBe(0);
      const payload = JSON.parse(out.join("\n")) as { skipped?: boolean; warnings?: string[] };
      expect(payload.skipped).toBe(true);
      expect(payload.warnings?.some((w) => w.includes("isAbstrakt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("meta gen — owned generator copies that are the shipped reference", () => {
  test("names them once, with the command that removes them, and still exits 0", async () => {
    const root = setupRepo({ typos: false });
    try {
      mkdirSync(join(root, "codegen/generators"), { recursive: true });
      // `barrel` is the smallest reference generator; copied verbatim it is the stock one.
      expect(await ejectCommand(["barrel"], root, "text")).toBe(0);
      err = [];
      expect(await run(["gen", "--cwd", root])).toBe(0);
      const notice = err.filter((l) => l.includes("meta eject --undo"));
      expect(notice).toHaveLength(1);
      expect(notice[0]).toContain("barrel");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("says nothing when the project owns no generator copy", async () => {
    const root = setupRepo({ typos: false });
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect(err.join("\n")).not.toContain("meta eject --undo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
