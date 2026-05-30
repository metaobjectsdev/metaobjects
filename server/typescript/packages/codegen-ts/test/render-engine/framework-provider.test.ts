// framework-provider — covers the hybrid Provider chain (D1 in the
// template-driven codegen design): the adopter's project `templates/`
// directory takes precedence over the framework defaults shipped by
// codegen-ts. Without a test the precedence could silently regress and
// adopters' overrides would be ignored.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileSystemProvider,
  ProviderChain,
  projectProvider,
  frameworkTemplatesDirForTests,
} from "../../src/render-engine/framework-provider.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "mo-fwprov-"));
  tmpDirs.push(dir);
  return dir;
}

describe("projectProvider() — D1 hybrid precedence", () => {
  test("a project's templates/<ref>.mustache wins over the framework default", () => {
    // Both the framework and the project ship a `docs/entity-page.md`
    // template. The framework's is the real shipped one (whatever it is);
    // the project's is a sentinel string. The chain MUST return the project
    // version for that ref.
    const projectRoot = makeTempProject();
    const projectTemplatesDir = join(projectRoot, "templates", "docs");
    mkdirSync(projectTemplatesDir, { recursive: true });
    const sentinel = "PROJECT OVERRIDE WINS\n";
    writeFileSync(
      join(projectTemplatesDir, "entity-page.md.mustache"),
      sentinel,
    );

    const provider = projectProvider(projectRoot);
    const resolved = provider.resolve("docs/entity-page.md");

    expect(resolved).toBe(sentinel);
  });

  test("a ref the project does NOT ship still resolves via the framework default", () => {
    // The project has its own templates/ directory but does NOT override
    // docs/entity-page.md. The chain must fall through to the framework.
    const projectRoot = makeTempProject();
    const projectTemplatesDir = join(projectRoot, "templates", "other");
    mkdirSync(projectTemplatesDir, { recursive: true });
    writeFileSync(join(projectTemplatesDir, "something.mustache"), "irrelevant\n");

    const provider = projectProvider(projectRoot);
    const resolved = provider.resolve("docs/entity-page.md");

    // Framework default exists; whatever its content, it must be a
    // non-empty string.
    expect(typeof resolved).toBe("string");
    expect(resolved!.length).toBeGreaterThan(0);
    expect(resolved).not.toBe("irrelevant\n");
  });

  test("projectProvider(undefined) returns the framework provider directly", () => {
    const provider = projectProvider(undefined);
    const resolved = provider.resolve("docs/entity-page.md");
    expect(typeof resolved).toBe("string");
    expect(resolved!.length).toBeGreaterThan(0);
  });

  test("project with no templates/ directory falls back to framework provider", () => {
    const projectRoot = makeTempProject();
    // intentionally do NOT create projectRoot/templates
    const provider = projectProvider(projectRoot);
    const resolved = provider.resolve("docs/entity-page.md");
    expect(typeof resolved).toBe("string");
    expect(resolved!.length).toBeGreaterThan(0);
  });
});

describe("ProviderChain", () => {
  test("first match wins; later providers don't shadow", () => {
    const a = new FileSystemProvider(frameworkTemplatesDirForTests());
    const projectRoot = makeTempProject();
    const templatesDir = join(projectRoot, "templates");
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, "x.mustache"), "FROM-PROJECT\n");
    const b = new FileSystemProvider(templatesDir);

    // Order: framework first, then project.
    // The chain must return the framework hit for refs the framework has,
    // and the project hit only when the framework misses.
    const chain = new ProviderChain([a, b]);

    // Framework has docs/entity-page.md — must resolve to that, not the
    // project's hypothetical override.
    expect(chain.resolve("docs/entity-page.md")).not.toBe("FROM-PROJECT\n");
    // Framework does NOT have `x` — must resolve to the project's.
    expect(chain.resolve("x")).toBe("FROM-PROJECT\n");
    // Nobody has `nope` — undefined.
    expect(chain.resolve("nope")).toBeUndefined();
  });
});
