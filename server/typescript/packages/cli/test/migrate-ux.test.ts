/**
 * Task 5: axi-conformant UX tests for `meta migrate`.
 *
 * Exercises:
 *   - migrate --help exits 0 and prints migrate-specific usage
 *   - re-running migrate with no changes is exit 0 with an explicit empty-state
 *   - no-snapshot gives a structured discoverability hint (not just a raw error)
 *   - PM-aware missing-dep error detects the right install command
 *   - structured {error, hint} on stdout for migrate failures (--format json)
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";
import { runBaseline, runOfflineGenerate, migrateCommand } from "../src/commands/migrate.js";
import { detectPackageManager } from "../src/lib/pm-detect.js";

// ---------------------------------------------------------------------------
// Fixture helpers — minimal metaobjects project with one entity
// ---------------------------------------------------------------------------

const dirs: string[] = [];

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mts-ux-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(
    join(root, "metaobjects", "meta.orders.json"),
    JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "ref" } },
                { "source.rdb": { name: "src", "@table": "orders" } },
                { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              ],
            },
          },
        ],
      },
    }),
    "utf8",
  );
  return root;
}

const baselineCfg = (root: string) =>
  ({
    dialect: "sqlite",
    outDir: "./.metaobjects/migrations",
    fromDb: false,
  }) as any;

const offlineCfg = (root: string) =>
  ({
    dialect: "sqlite",
    outDir: "./.metaobjects/migrations",
    onAmbiguous: "abort",
    allow: [],
    slug: "auto",
    dryRun: false,
  }) as any;

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Capture console.log output during a run() invocation. */
async function captureRun(argv: string[]): Promise<{ exit: number; stdout: string }> {
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  let exit: number;
  try {
    exit = await run(argv);
  } finally {
    console.log = origLog;
  }
  return { exit, stdout: captured.join("\n") };
}

/** Capture console.log during a migrateCommand() invocation. */
async function captureCommand(
  args: string[],
  cwd: string,
  fmt: "text" | "toon" | "json" = "text",
): Promise<{ exit: number; stdout: string }> {
  const captured: string[] = [];
  const origLog = console.log;
  console.log = (...logArgs: unknown[]) => {
    captured.push(logArgs.map(String).join(" "));
  };
  let exit: number;
  try {
    exit = await migrateCommand(args, cwd, undefined, fmt);
  } finally {
    console.log = origLog;
  }
  return { exit, stdout: captured.join("\n") };
}

// ---------------------------------------------------------------------------
// 1. migrate --help
// ---------------------------------------------------------------------------

describe("migrate --help", () => {
  test("exits 0 and prints migrate-specific usage via run()", async () => {
    const { exit, stdout } = await captureRun(["migrate", "--help"]);
    expect(exit).toBe(0);
    // Must mention the core migrate flags
    expect(stdout).toContain("--db");
    expect(stdout).toContain("--slug");
    expect(stdout).toContain("baseline");
  });

  test("exits 0 with -h shorthand", async () => {
    const { exit, stdout } = await captureRun(["migrate", "-h"]);
    expect(exit).toBe(0);
    expect(stdout).toContain("--db");
  });

  test("--help works alongside other flags (help takes priority)", async () => {
    const { exit, stdout } = await captureRun(["migrate", "--dialect", "sqlite", "--help"]);
    expect(exit).toBe(0);
    expect(stdout).toContain("--db");
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotency: no changes is exit 0 with an explicit empty-state
// ---------------------------------------------------------------------------

describe("migrate idempotency (offline)", () => {
  test("re-running offline migrate with no changes is exit 0 with explicit no-changes message", async () => {
    const root = await project();
    // Baseline first
    await runBaseline(baselineCfg(root), root);

    // Capture stdout from the no-changes run
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    let exitCode: number;
    try {
      exitCode = await runOfflineGenerate(offlineCfg(root), root);
    } finally {
      console.log = origLog;
    }

    expect(exitCode).toBe(0);
    const output = captured.join("\n");
    // Must say "no changes" (not an error, not empty)
    expect(output.toLowerCase()).toContain("no changes");
  });
});

// ---------------------------------------------------------------------------
// 3. Baseline discoverability: no-snapshot gives a structured next-step hint
// ---------------------------------------------------------------------------

describe("migrate offline: no-snapshot discoverability hint", () => {
  test("when no snapshot exists, exits 2 and prints a baseline next-step hint on stdout", async () => {
    const root = await project();
    // No baseline run — snapshot doesn't exist

    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    let exitCode: number;
    try {
      exitCode = await runOfflineGenerate(offlineCfg(root), root);
    } finally {
      console.log = origLog;
    }

    expect(exitCode).toBe(2);
    const output = captured.join("\n");
    // Must mention 'baseline' as the next step
    expect(output).toContain("baseline");
  });
});

// ---------------------------------------------------------------------------
// 4. PM-aware missing-dep error detection
// ---------------------------------------------------------------------------

describe("detectPackageManager", () => {
  test("returns npm when package-lock.json exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mts-pm-"));
    dirs.push(dir);
    await writeFile(join(dir, "package-lock.json"), "{}", "utf8");
    expect(await detectPackageManager(dir)).toBe("npm");
  });

  test("returns pnpm when pnpm-lock.yaml exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mts-pm-"));
    dirs.push(dir);
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '6.0'", "utf8");
    expect(await detectPackageManager(dir)).toBe("pnpm");
  });

  test("returns bun when bun.lockb exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mts-pm-"));
    dirs.push(dir);
    await writeFile(join(dir, "bun.lockb"), "", "utf8");
    expect(await detectPackageManager(dir)).toBe("bun");
  });

  test("returns bun as default when no lockfile is found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mts-pm-"));
    dirs.push(dir);
    // No lockfile written
    expect(await detectPackageManager(dir)).toBe("bun");
  });
});

// ---------------------------------------------------------------------------
// 5. Structured {error, hint} on stdout for failures (--format json)
// ---------------------------------------------------------------------------

describe("migrate structured error output (--format json)", () => {
  test("parse error (bad --allow token) surfaces as structured JSON on stdout", async () => {
    const root = await project();
    // Pass an invalid --allow token so parseMigrateArgs throws
    const { exit, stdout } = await captureRun([
      "--format",
      "json",
      "migrate",
      "--cwd",
      root,
      "--allow",
      "invalid-token",
    ]);
    // Should fail (exit non-zero)
    expect(exit).not.toBe(0);
    // stdout must contain a JSON object with an "error" key
    expect(stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout.trim());
    expect(typeof parsed.error).toBe("string");
    expect(typeof parsed.hint).toBe("string");
  });

  test("parse error (bad --allow token) surfaces as TOON on stdout with --format toon", async () => {
    const root = await project();
    const { exit, stdout } = await captureRun([
      "--format",
      "toon",
      "migrate",
      "--cwd",
      root,
      "--allow",
      "invalid-token",
    ]);
    expect(exit).not.toBe(0);
    // TOON-encoded: contains the key names
    expect(stdout).toContain("error");
    expect(stdout).toContain("hint");
  });
});
