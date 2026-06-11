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

/** Build a standalone project root holding metaobjects/ — NO gen config. Also
 *  drops the mustache source the WelcomePage @textRef ("site/welcome") resolves
 *  to, so the template page's "## Template source" section has real source. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-docs-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(
    join(root, "metaobjects", "meta.json"),
    JSON.stringify(META),
    "utf8",
  );
  await mkdir(join(root, "templates", "site"), { recursive: true });
  await writeFile(
    join(root, "templates", "site", "welcome.mustache"),
    "<h1>Welcome, {{name}}!</h1>\n<p>{{headline}}</p>\n",
    "utf8",
  );
  return root;
}

// Metadata using a CUSTOM field subtype (`field.geopoint`) that only a
// consumer-supplied provider in metaobjects.config.ts can resolve.
const CUSTOM_META = {
  "metadata.root": {
    package: "acme::geo",
    children: [
      {
        "object.value": {
          name: "Place",
          children: [
            { "field.string": { name: "name" } },
            // Resolves ONLY when the config's geopoint provider is loaded.
            { "field.geopoint": { name: "location" } },
          ],
        },
      },
    ],
  },
};

// A metaobjects.config.ts that registers the `field.geopoint` subtype via a
// consumer provider (mirrors how an adopter ships custom types to gen/migrate).
const CUSTOM_CONFIG = [
  `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
  `import { entityFile } from "@metaobjectsdev/codegen-ts/generators";`,
  `import { TypeId, TYPE_FIELD, MetaField } from "@metaobjectsdev/metadata";`,
  `const geoProvider = {`,
  `  id: "test-geo",`,
  `  dependencies: ["metaobjects-core-types"],`,
  `  registerTypes(registry) {`,
  `    registry.register({`,
  `      typeId: new TypeId(TYPE_FIELD, "geopoint"),`,
  `      description: "A geographic point field",`,
  `      factory: (typeId, name) => new MetaField(typeId, name),`,
  `      childRules: [],`,
  `      attributes: [],`,
  `    });`,
  `  },`,
  `};`,
  `export default defineConfig({`,
  `  outDir: "out",`,
  `  dialect: "sqlite",`,
  `  generators: [entityFile()],`,
  `  providers: [geoProvider],`,
  `});`,
].join("\n");

/** Project root with metadata using a custom type + a config that provides it. */
async function customTypeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-docs-custom-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(
    join(root, "metaobjects", "meta.json"),
    JSON.stringify(CUSTOM_META),
    "utf8",
  );
  await writeFile(join(root, "metaobjects.config.ts"), CUSTOM_CONFIG, "utf8");
  return root;
}

// TWO-package metadata with a SHORT-NAME collision across packages: an
// `object.value acme::sales::Order` and a `template.output acme::comms::Order`.
// In flat layout both want `Order.md` (collision → hard error); in package
// layout they fold under distinct subdirs.
const COLLIDING_META = {
  "metadata.root": {
    children: [
      {
        "object.value": {
          name: "Order",
          package: "acme::sales",
          children: [{ "field.string": { name: "sku" } }],
        },
      },
      {
        "template.output": {
          name: "Order",
          package: "acme::comms",
          "@kind": "document",
          "@payloadRef": "Order",
          "@textRef": "comms/order",
          "@format": "html",
        },
      },
    ],
  },
};

/** Project root holding the cross-package short-name collision metadata. */
async function collidingProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "meta-docs-collide-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(
    join(root, "metaobjects", "meta.json"),
    JSON.stringify(COLLIDING_META),
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

    // Entity page is the neutral metadata contract. (The former separate
    // `## Constraints` + `## Storage` sections were merged into one neutral
    // `## Fields` table carrying a Rules column — see entity-page.md.mustache.)
    expect(entity).toContain("## Fields");
    // Template page declares its render contract.
    expect(template).toContain("**Kind:**");
    // Template page embeds the linked, highlighted template SOURCE resolved via
    // the project's templates/ dir (the same provider the drift gate uses).
    expect(template).toContain("## Template source");
    expect(template).toContain("```mustache");
    expect(template).toContain("<h1>Welcome, {{name}}!</h1>");
    expect(template).toContain("[Welcome.name](./Welcome.md#field-name)");
    expect(template).toContain("<summary>Linked view</summary>");

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
    // Mentions counts + destination, including the overview/index page.
    expect(summary).toMatch(/1 overview/);
    expect(summary).toMatch(/1 entity/);
    expect(summary).toMatch(/1 template/);
    expect(summary).toContain(out);
  });

  test("emits a neutral README.md overview with an embedded Mermaid ER diagram", async () => {
    const root = await project();
    const out = join(root, "out-overview");
    expect(await docsCommand([root, "--out", out], root)).toBe(0);

    // The overview/index page lands at the docs root as README.md.
    expect(existsSync(join(out, "README.md"))).toBe(true);
    const readme = await readFile(join(out, "README.md"), "utf8");

    // Carries the fenced Mermaid ER diagram + links to the model's pages.
    expect(readme).toContain("```mermaid");
    expect(readme).toContain("erDiagram");
    // Links every entity + template page emitted in the same run.
    expect(readme).toContain("(./Welcome.md)");
    expect(readme).toContain("(./WelcomePage.md)");

    // Neutral — no language/toolchain leakage (".md" links allowed).
    expect(readme.replace(/\.md\b/g, "")).not.toMatch(/\.ts\b/);
    expect(readme).not.toContain("Zod");
    expect(readme).not.toContain("## Generated code");
  });

  test("loads metaobjects.config.ts providers so custom types resolve", async () => {
    const root = await customTypeProject();
    const out = join(root, "out-custom");

    // The metadata uses field.geopoint, which is NOT a core subtype — it only
    // resolves via the provider declared in metaobjects.config.ts. Before docs
    // loaded the config providers, this load failed with an unknown-subtype
    // error and docs returned non-zero.
    const code = await docsCommand([root, "--out", out], root);
    expect(code).toBe(0);

    const files = await readdir(out);
    expect(files).toContain("Place.md");
  });

  test("a broken metaobjects.config.ts is surfaced (not silently swallowed), docs still generate", async () => {
    // Basic metadata (no custom types) + a config that THROWS on load. Docs must
    // still succeed config-less, but the real config error must be surfaced as a
    // warning rather than silently degrading to provider-less docs.
    const root = await project();
    await writeFile(
      join(root, "metaobjects.config.ts"),
      "throw new Error('broken config boom');\n",
      "utf8",
    );
    const out = join(root, "out-brokencfg");

    const errLogged: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      errLogged.push(args.map(String).join(" "));
    };
    let code: number;
    try {
      code = await docsCommand([root, "--out", out], root);
    } finally {
      console.error = origErr;
    }

    expect(code).toBe(0); // config-less generation still works
    const files = await readdir(out);
    expect(files.length).toBeGreaterThan(0);
    // The config failure is SURFACED (warning on stderr), not silently swallowed,
    // and carries the loader's real diagnostic so the user can fix it.
    const stderr = errLogged.join("\n");
    expect(stderr).toContain("metaobjects.config.ts failed to load");
    expect(stderr).toContain("generating docs without its providers");
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

  test("default (flat) on a cross-package short-name collision → non-zero, no overwrite", async () => {
    const root = await collidingProject();
    const out = join(root, "out-collide-flat");

    const errLogged: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errLogged.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await docsCommand([root, "--out", out], root);
    } finally {
      console.error = origErr;
    }

    expect(code).not.toBe(0); // hard error, not a silent overwrite
    const stderr = errLogged.join("\n");
    expect(stderr).toContain("duplicate output path");
    expect(stderr).toContain("Order.md");
    expect(stderr).toContain("acme::sales::Order");
    expect(stderr).toContain("acme::comms::Order");
  });

  test("--layout package: distinct nested files, exit 0", async () => {
    const root = await collidingProject();
    const out = join(root, "out-collide-pkg");

    const code = await docsCommand([root, "--out", out, "--layout", "package"], root);
    expect(code).toBe(0);

    // Both pages survive under package-folded subdirs.
    expect(existsSync(join(out, "acme", "sales", "Order.md"))).toBe(true);
    expect(existsSync(join(out, "acme", "comms", "Order.md"))).toBe(true);
  });

  test("--layout package preserves single-package output as nested (no flat regression)", async () => {
    // The default-flat single-package fixture still emits flat <name>.md.
    const root = await project();
    const out = join(root, "out-flat-default");
    expect(await docsCommand([root, "--out", out], root)).toBe(0);
    expect(existsSync(join(out, "Welcome.md"))).toBe(true);
    expect(existsSync(join(out, "WelcomePage.md"))).toBe(true);
  });

  test("--layout rejects an invalid value", async () => {
    const root = await project();
    const out = join(root, "out-badlayout");
    const code = await docsCommand([root, "--out", out, "--layout", "nested"], root);
    expect(code).toBe(2); // arg parse error
  });
});
