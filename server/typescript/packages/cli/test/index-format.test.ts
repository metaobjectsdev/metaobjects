/**
 * Task 4: Dispatch-level tests for the global --format flag.
 *
 * Strategy: capture console.log (log.info → console.log) then inspect the
 * output shape. We use the trainer-website-meta fixture (has a real User
 * entity) + a transient metaobjects.config.ts so `meta gen` actually runs.
 *
 * Three branches are exercised:
 *   --format toon  → TOON tabular block  ("gen[…]{…}:")
 *   --format json  → JSON object          (starts with "{")
 *   --format text  → word-table           ("meta gen", status words)
 *
 * resolveFormat selection is also tested at the unit level so the dispatch
 * boundary is verified independently of the live gen run.
 */
import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../src/index.js";
import { resolveFormat } from "../src/lib/format.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures");
const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures/__tmp__");

/** Capture console.log calls during a run() invocation. */
async function captureRun(argv: string[]): Promise<{ exit: number; output: string }> {
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
  let exit: number;
  try {
    exit = await run(argv);
  } finally {
    console.log = origLog;
  }
  return { exit, output: captured.join("\n") };
}

// ---------------------------------------------------------------------------
// Unit: resolveFormat selection at the dispatch boundary
// ---------------------------------------------------------------------------
describe("resolveFormat — dispatch boundary (unit)", () => {
  test("--format toon resolves to toon regardless of TTY", () => {
    expect(resolveFormat("toon", true)).toBe("toon");
    expect(resolveFormat("toon", false)).toBe("toon");
  });
  test("--format json resolves to json regardless of TTY", () => {
    expect(resolveFormat("json", true)).toBe("json");
    expect(resolveFormat("json", false)).toBe("json");
  });
  test("--format text resolves to text regardless of TTY", () => {
    expect(resolveFormat("text", true)).toBe("text");
    expect(resolveFormat("text", false)).toBe("text");
  });
  test("unknown format falls back to TTY-aware default (resolveFormat is reached only post-validation)", () => {
    // resolveFormat itself is total — dispatch rejects unknown values before it runs.
    expect(resolveFormat("bogus", true)).toBe("text");
    expect(resolveFormat("bogus", false)).toBe("toon");
  });
  test("absent flag defaults TTY-aware: text on TTY, toon off-TTY", () => {
    expect(resolveFormat(undefined, true)).toBe("text");
    expect(resolveFormat(undefined, false)).toBe("toon");
  });
});

// ---------------------------------------------------------------------------
// Dispatch: an unrecognized --format is a usage error (exit 2), not a silent default
// ---------------------------------------------------------------------------
describe("--format validation (dispatch)", () => {
  /** Capture console.error during a run() and return exit + stderr. */
  async function captureRunErr(argv: string[]): Promise<{ exit: number; err: string }> {
    const captured: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
    let exit: number;
    try {
      exit = await run(argv);
    } finally {
      console.error = origErr;
    }
    return { exit, err: captured.join("\n") };
  }

  test("--format jsonn (typo) exits 2 with a usage error", async () => {
    const { exit, err } = await captureRunErr(["gen", "--format", "jsonn"]);
    expect(exit).toBe(2);
    expect(err).toContain("--format must be one of");
  });

  test("--format=bogus (equals-form typo) exits 2", async () => {
    const { exit } = await captureRunErr(["gen", "--format=bogus"]);
    expect(exit).toBe(2);
  });

  test("empty --format= exits 2", async () => {
    const { exit } = await captureRunErr(["gen", "--format="]);
    expect(exit).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Integration: meta gen --format with the trainer-website-meta fixture
// ---------------------------------------------------------------------------
describe("meta gen --format (integration)", () => {
  /**
   * Create a temp workspace with the trainer-website-meta fixture + a
   * metaobjects.config.ts that writes generated files into a sandboxed
   * sub-directory (codegen-ts writes even on --dry-run; this keeps generated
   * files away from the cli package's own src/).
   */
  function makeWorkspace(): { root: string; outDir: string } {
    mkdirSync(WORKSPACE_TMP, { recursive: true });
    const root = mkdtempSync(join(WORKSPACE_TMP, "format-flag-"));
    cpSync(join(FIXTURES, "trainer-website-meta"), root, { recursive: true });
    const outDir = join(root, "generated", "db");
    writeFileSync(
      join(root, "metaobjects.config.ts"),
      `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(outDir)},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: ["entity"],
});
`,
    );
    return { root, outDir };
  }

  test("--format toon emits TOON tabular block (gen[ header)", async () => {
    const { root } = makeWorkspace();
    try {
      const { exit, output } = await captureRun(["gen", "--format", "toon", "--cwd", root]);
      expect(exit).toBe(0);
      // TOON tabular block: "gen[N]{file,status}:"
      expect(output).toMatch(/gen\[\d+\]\{file,status\}:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format json emits a JSON object with a 'gen' array", async () => {
    const { root } = makeWorkspace();
    try {
      const { exit, output } = await captureRun(["gen", "--format", "json", "--cwd", root]);
      expect(exit).toBe(0);
      const parsed = JSON.parse(output.trim());
      expect(Array.isArray(parsed.gen)).toBe(true);
      // Each entry must have file + status fields.
      for (const entry of parsed.gen) {
        expect(typeof entry.file).toBe("string");
        expect(typeof entry.status).toBe("string");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format text emits the word-table (meta gen header + status words)", async () => {
    const { root } = makeWorkspace();
    try {
      const { exit, output } = await captureRun(["gen", "--format", "text", "--cwd", root]);
      expect(exit).toBe(0);
      // Text format always begins with the 'meta gen' header.
      expect(output).toContain("meta gen");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format flag is consumed globally (can appear before the command)", async () => {
    const { root } = makeWorkspace();
    try {
      // --format before gen — global extraction must handle this.
      const { exit, output } = await captureRun(["--format", "toon", "gen", "--cwd", root]);
      expect(exit).toBe(0);
      expect(output).toMatch(/gen\[\d+\]\{file,status\}:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format=toon= (equals-form) is also accepted", async () => {
    const { root } = makeWorkspace();
    try {
      const { exit, output } = await captureRun(["gen", "--format=toon", "--cwd", root]);
      expect(exit).toBe(0);
      expect(output).toMatch(/gen\[\d+\]\{file,status\}:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
