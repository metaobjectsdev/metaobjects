import { describe, test, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docsCommand } from "../src/commands/docs.js";
import { run } from "../src/index.js";

// Metadata with ONE entity (object.value Welcome) + ONE template.output
// (WelcomePage). Mirrors fixtures/conformance/template-doc-document so the
// emitted pages exercise both the entity-page and the template-page paths.
const META = {
  "metadata.root": {
    package: "acme::site",
    children: [
      {
        "object.value": {
          name: "Welcome",
          children: [
            { "field.string": { name: "name" } },
            { "field.string": { name: "headline" } },
          ],
        },
      },
      {
        "template.output": {
          name: "WelcomePage",
          "@kind": "document",
          "@payloadRef": "Welcome",
          "@textRef": "site/welcome",
          "@format": "html",
          "@maxChars": 5000,
          "@requiredTags": ["section"],
        },
      },
    ],
  },
};

const dirs: string[] = [];

/** Build a standalone project root holding metaobjects/ — NO gen config. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-docs-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(
    join(root, "metaobjects", "meta.json"),
    JSON.stringify(META),
    "utf8",
  );
  return root;
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// Capture stdout so we can assert the summary line.
let logged: string[];
let origLog: typeof console.log;
beforeEach(() => {
  logged = [];
  origLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
});
afterEach(() => {
  console.log = origLog;
});

describe("meta docs — standalone neutral metadata docs", () => {
  test("emits an entity page AND a template page from metadata alone", async () => {
    const root = await project();
    const out = join(root, "out-docs");

    // No gen config present anywhere — proves this is metadata-only.
    expect(existsSync(join(root, "metaobjects.config.ts"))).toBe(false);
    expect(existsSync(join(root, ".metaobjects", "config.json"))).toBe(false);

    const code = await docsCommand([root, "--out", out], root);
    expect(code).toBe(0);

    const files = (await readdir(out)).sort();
    expect(files).toContain("Welcome.md");
    expect(files).toContain("WelcomePage.md");
  });

  test("entity + template pages are NEUTRAL (no codegen leakage)", async () => {
    const root = await project();
    const out = join(root, "out-neutral");
    expect(await docsCommand([root, "--out", out], root)).toBe(0);

    const entity = await readFile(join(out, "Welcome.md"), "utf8");
    const template = await readFile(join(out, "WelcomePage.md"), "utf8");

    // Entity page is the neutral metadata contract.
    expect(entity).toContain("## Constraints");
    // Template page declares its render contract.
    expect(template).toContain("**Kind:**");

    // Neutral: no language/toolchain leakage in either page.
    for (const page of [entity, template]) {
      expect(page).not.toContain("Zod");
      expect(page).not.toContain(".ts");
      expect(page).not.toContain("## Generated code");
    }
  });

  test("prints a summary of pages written to --out", async () => {
    const root = await project();
    const out = join(root, "out-summary");
    expect(await docsCommand([root, "--out", out], root)).toBe(0);

    const summary = logged.join("\n");
    // Mentions counts + destination.
    expect(summary).toMatch(/1 entity/);
    expect(summary).toMatch(/1 template/);
    expect(summary).toContain(out);
  });

  test("exits non-zero with a clear message when metadata is missing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "meta-docs-empty-"));
    dirs.push(empty);
    const out = join(empty, "out");
    const code = await docsCommand([empty, "--out", out], empty);
    expect(code).not.toBe(0);
  });

  test("docs is registered in the top-level dispatcher", async () => {
    const root = await project();
    const out = join(root, "out-dispatch");
    // run() dispatches the docs command (would return 2 'Unknown command'
    // if it were not registered).
    const code = await run(["docs", root, "--out", out]);
    expect(code).toBe(0);
    expect(existsSync(join(out, "Welcome.md"))).toBe(true);
  });

  test("--help lists docs", async () => {
    expect(await run(["--help"])).toBe(0);
    const help = logged.join("\n");
    expect(help).toContain("docs");
  });
});
