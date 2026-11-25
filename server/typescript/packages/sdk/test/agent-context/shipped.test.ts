// The shipped agent-context tree (`agent-context-shipped/`): the static agent files assembled at
// build time, one tree per server language and client choice, that every non-TypeScript port
// embeds and its own `agent-docs` command copies (1.3.0 design call 17).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { assemble } from "../../src/agent-context/assemble.js";
import { makeStack } from "../../src/agent-context/resolve.js";
import {
  SHIPPED_CLIENT_SETS, SHIPPED_MANIFEST_FILE, SHIPPED_MIGRATION_CHOICES, SHIPPED_SERVER_SETS,
  buildShippedAgentContext, materializeShippedStack, shippedStackId, shippedTreeFiles,
  type ShippedManifest,
} from "../../src/agent-context/shipped.js";
import { SERVER_LANGS, type ClientFramework, type ServerLang } from "../../src/agent-context/types.js";

const REPO_ROOT = join(import.meta.dir, "../../../../../..");
const CONTENT_ROOT = join(REPO_ROOT, "agent-context");
const SHIPPED_DIR = join(REPO_ROOT, "agent-context-shipped");
const CORPUS = join(REPO_ROOT, "fixtures/agent-context-conformance");

const built = buildShippedAgentContext(CONTENT_ROOT);

function tree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out.set(relative(root, abs).split(sep).join("/"), readFileSync(abs, "utf8"));
    }
  };
  walk(root);
  return out;
}

/** The committed tree, read back the way a port's build reads it: manifest plus stored files. */
function committed(): { manifest: ShippedManifest; files: Map<string, string> } {
  const all = tree(SHIPPED_DIR);
  const manifest = JSON.parse(all.get(SHIPPED_MANIFEST_FILE)!) as ShippedManifest;
  const files = new Map<string, string>();
  for (const [p, c] of all) if (p.startsWith("files/")) files.set(p.slice("files/".length), c);
  return { manifest, files };
}

describe("the committed tree is the one the build writes", () => {
  test("byte for byte, with nothing extra", () => {
    // The drift gate. A change to agent-context/ that did not rebuild the tree ships ports a
    // stale copy, so it fails here, naming each file.
    const want = shippedTreeFiles(built);
    const have = tree(SHIPPED_DIR);
    have.delete("README.md"); // hand-written
    const stale = [...want].filter(([p, c]) => have.get(p) !== c).map(([p]) => p);
    const extra = [...have.keys()].filter((p) => !want.has(p));
    expect({ stale, extra }, "run: bun server/typescript/packages/sdk/scripts/build-shipped-agent-context.ts")
      .toEqual({ stale: [], extra: [] });
  });
});

describe("the stacks shipped", () => {
  test("every server language alone and Java with Kotlin, each with every client choice, with and without meta migrate", () => {
    const servers = SHIPPED_SERVER_SETS.map((s) => s.join("+"));
    expect(servers).toEqual([...SERVER_LANGS, "java+kotlin"]);
    expect(SHIPPED_CLIENT_SETS.map((c) => c.join("+"))).toEqual(["", "react", "react+tanstack", "angular"]);
    expect(SHIPPED_MIGRATION_CHOICES).toEqual([false, true]);
    expect(built.manifest.stacks.length).toBe(servers.length * SHIPPED_CLIENT_SETS.length * 2);
  });

  test("only a stack that chose a meta migrate dialect carries the reference helper's steps", () => {
    const agentsOf = (migration: boolean): string => {
      const files = materializeShippedStack(built, makeStack(["python"], [], migration), "main");
      return files.find((f) => f.path === ".metaobjects/AGENTS.md")!.contents;
    };
    expect(shippedStackId({ servers: ["python"], clients: [], migration: true })).toBe("python-migrate");
    expect(agentsOf(true)).toContain("### Schema, with the reference migration helper");
    expect(agentsOf(true)).toContain("npx meta verify --db <url>");
    expect(agentsOf(false)).not.toContain("meta migrate");
    expect(agentsOf(false)).not.toContain("verify --db");
    expect(agentsOf(false)).toContain("Commit the metadata, the generated code and `.metaobjects/.gen-state/.hashes/`.");
  });

  test("a Rust tree is shipped", () => {
    expect(built.manifest.stacks.map((s) => s.id)).toContain("rust");
  });

  test("ids are unique, and the id of a stack is what the port computes from it", () => {
    const ids = built.manifest.stacks.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of built.manifest.stacks) expect(shippedStackId(s)).toBe(s.id);
    // Order-insensitive: a port that collects `--server kotlin --server java` gets the same tree.
    expect(shippedStackId({ servers: ["kotlin", "java"], clients: ["tanstack", "react"] }))
      .toBe("java-kotlin-react-tanstack");
  });

  test("a file shared by many stacks is stored once", () => {
    const refs = built.manifest.stacks.flatMap((s) => s.files.map((f) => f.file));
    expect(built.files.size).toBe(new Set(refs).size);
    expect(built.files.size).toBeLessThan(refs.length / 10);
  });
});

describe("what a port writes from the tree", () => {
  // The oracle is the assembler itself, which is what `meta agent-docs` writes for the same
  // stack. A port copying a tree must write the same files as the Node CLI would.
  for (const s of built.manifest.stacks) {
    test(`${s.id}: the assembler's files, pinned to the release's ref`, () => {
      const stack = makeStack([...s.servers], [...s.clients], s.migration);
      const ref = "v1.3.0";
      const viaTree = materializeShippedStack(committed(), stack, ref);
      const direct = assemble({ contentRoot: CONTENT_ROOT, stack, docsRef: ref });
      expect(viaTree).toEqual(direct.map((f) => ({ path: f.path, contents: f.contents })));
    });
  }

  test("the links are pinned: no guide link is left on main", () => {
    const { manifest } = built;
    const files = materializeShippedStack(built, makeStack(["python"], []), "v1.3.0");
    const onMain = `${manifest.docsLinkPrefix}main/`;
    expect(files.some((f) => f.contents.includes(`${manifest.docsLinkPrefix}v1.3.0/`))).toBe(true);
    expect(files.filter((f) => f.contents.includes(onMain)).map((f) => f.path)).toEqual([]);
  });

  test("the shared conformance goldens come out of the tree unchanged", () => {
    // An independent oracle: the committed agent-context-conformance goldens.
    const cases = readdirSync(CORPUS).filter((n) => existsSync(join(CORPUS, n, "stack.json")));
    expect(cases.length).toBeGreaterThan(0);
    for (const name of cases) {
      const spec = JSON.parse(readFileSync(join(CORPUS, name, "stack.json"), "utf8")) as {
        servers: ServerLang[];
        clients: ClientFramework[];
        migrate?: boolean;
      };
      const files = materializeShippedStack(committed(), makeStack(spec.servers, spec.clients, spec.migrate === true), "main");
      const expected = tree(join(CORPUS, name, "expected"));
      expect(new Map(files.map((f) => [f.path, f.contents])), name).toEqual(expected);
    }
  });

  test("a stack with no shipped tree is refused, naming the ones shipped", () => {
    expect(() => materializeShippedStack(built, makeStack(["python", "csharp"], []), "main"))
      .toThrow(/no shipped tree for the stack "csharp-python" \(shipped: typescript, /);
  });
});

describe("the Rust tree", () => {
  const files = new Map(
    materializeShippedStack(built, makeStack(["rust"], []), "main").map((f) => [f.path, f.contents]),
  );
  const agents = files.get(".metaobjects/AGENTS.md")!;

  test("its loop and its verify step are Rust's own command", () => {
    expect(agents).toContain("> Stack: rust server, no client.");
    expect(agents).toContain("### Rust: generate with `cargo meta gen`");
    expect(agents).toContain("- `cargo meta verify` (the generated crates and the business rules;");
  });

  test("it never tells a Rust project about another port's config or command", () => {
    for (const other of ["metaobjects.config.ts", "metaobjects.config.yaml", "dotnet meta", "mvn metaobjects", "metaobjects gen"]) {
      expect(agents.includes(other), other).toBe(false);
    }
  });
});
