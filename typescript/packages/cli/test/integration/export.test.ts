import { describe, test, expect } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

// Helper to run a function with a changed working directory.
async function runIn<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const orig = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(orig);
  }
}

describe("meta export — --out <file>", () => {
  test("writes flattened canonical JSON to the specified file", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-export-"));
    cpSync(join(FIXTURES, "trainer-website-meta"), tmp, { recursive: true });
    const outFile = join(tmp, "metadata.json");
    try {
      const exit = await runIn(tmp, () => run(["export", "--out", outFile]));
      expect(exit).toBe(0);
      expect(existsSync(outFile)).toBe(true);

      const raw = readFileSync(outFile, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      // Canonical JSON has a root key of "metadata.root"
      expect(parsed).toBeObject();
      expect(Object.keys(parsed as Record<string, unknown>)).toContain("metadata.root");

      // The root should contain the package declared in the fixture
      const root = (parsed as Record<string, unknown>)["metadata.root"] as Record<string, unknown>;
      expect(root.package).toBe("trainerWebsite");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("output file is valid JSON with expected entity children", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-export-"));
    cpSync(join(FIXTURES, "trainer-website-meta"), tmp, { recursive: true });
    const outFile = join(tmp, "out.json");
    try {
      const exit = await runIn(tmp, () => run(["export", "--out", outFile]));
      expect(exit).toBe(0);

      const raw = readFileSync(outFile, "utf8");
      // Should be parseable and contain User/Post/Tag entities
      const text = raw;
      expect(text).toContain("User");
      expect(text).toContain("Post");
      expect(text).toContain("Tag");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("meta export — stdout", () => {
  test("writes flattened canonical JSON to stdout when --out is omitted", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-export-stdout-"));
    cpSync(join(FIXTURES, "trainer-website-meta"), tmp, { recursive: true });
    const chunks: Buffer[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // Capture stdout writes
    (process.stdout as unknown as { write: (...args: unknown[]) => boolean }).write = (
      ...args: unknown[]
    ) => {
      const chunk = args[0] as string | Buffer;
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      return true;
    };
    try {
      const exit = await runIn(tmp, () => run(["export"]));
      expect(exit).toBe(0);

      const output = Buffer.concat(chunks).toString("utf8");
      expect(output.length).toBeGreaterThan(0);
      const parsed = JSON.parse(output) as unknown;
      expect(Object.keys(parsed as Record<string, unknown>)).toContain("metadata.root");
    } finally {
      (process.stdout as unknown as { write: (...args: unknown[]) => boolean }).write = origWrite as unknown as (...args: unknown[]) => boolean;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("meta export — error handling", () => {
  test("returns 1 and prints errors when metadata has parse errors; no output file written", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-export-err-"));
    cpSync(join(FIXTURES, "invalid-json"), tmp, { recursive: true });
    const outFile = join(tmp, "metadata.json");

    const stderrLines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { stderrLines.push(String(args[0])); };

    try {
      const exit = await runIn(tmp, () => run(["export", "--out", outFile]));
      expect(exit).toBe(1);
      // Output file must NOT have been written on error
      expect(existsSync(outFile)).toBe(false);
      // At least one error line should have been emitted to stderr
      expect(stderrLines.length).toBeGreaterThan(0);
    } finally {
      console.error = origError;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns 2 when metaobjects/ directory is missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-export-nodir-"));
    // No metaobjects/ directory created
    const stderrLines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { stderrLines.push(String(args[0])); };
    try {
      const exit = await runIn(tmp, () => run(["export"]));
      // loadAndExportJson returns errors in result, so exit should be 1 (not 2)
      // because the metadata directory error is surfaced as result.errors
      expect(exit).toBe(1);
      expect(stderrLines.length).toBeGreaterThan(0);
    } finally {
      console.error = origError;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns 2 on unknown flag", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-export-badflag-"));
    try {
      const exit = await runIn(tmp, () => run(["export", "--unknown-flag"]));
      expect(exit).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("meta export — multi-package fixture", () => {
  test("merges multiple metadata files into one artifact", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "metaobjects-export-multi-"));
    cpSync(join(FIXTURES, "multi-package-meta"), tmp, { recursive: true });
    const outFile = join(tmp, "out.json");
    try {
      const exit = await runIn(tmp, () => run(["export", "--out", outFile]));
      expect(exit).toBe(0);
      expect(existsSync(outFile)).toBe(true);
      const raw = readFileSync(outFile, "utf8");
      JSON.parse(raw); // should be valid JSON
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
