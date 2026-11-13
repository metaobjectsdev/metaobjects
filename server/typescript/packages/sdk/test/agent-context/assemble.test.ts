// test/agent-context/assemble.test.ts
import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assemble } from "../../src/agent-context/assemble.js";
import { makeStack } from "../../src/agent-context/resolve.js";

const CONTENT_ROOT = join(import.meta.dir, "../../../../../../agent-context"); // test/agent-context/ → repo root is 6 levels up

function paths(files: { path: string }[]): string[] {
  return files.map((f) => f.path).sort();
}

describe("assemble pins guide links", () => {
  const stack = makeStack(["typescript"], ["react"]);
  test("by default the links keep the authored ref (main)", () => {
    const all = assemble({ contentRoot: CONTENT_ROOT, stack }).map((f) => f.contents).join("\n");
    expect(all).toContain("metaobjects/blob/main/docs/");
  });
  test("with docsRef every repository blob link names that ref and none is left on main", () => {
    const files = assemble({ contentRoot: CONTENT_ROOT, stack, docsRef: "v1.1.0" });
    const all = files.map((f) => f.contents).join("\n");
    expect(all).toContain("metaobjects/blob/v1.1.0/docs/features/migrations/");
    expect(all).not.toContain("metaobjects/blob/main/");
  });
});

describe("assemble", () => {
  test("emits one AGENTS.md (no duplicate CLAUDE.md) with the stack line + codegen command substituted", () => {
    const stack = makeStack(["typescript"], ["react"]);
    const files = assemble({ contentRoot: CONTENT_ROOT, stack });
    const agents = files.find((f) => f.path === ".metaobjects/AGENTS.md")!;
    expect(agents).toBeDefined();
    // The root AGENTS.md / CLAUDE.md import this one file; a second identical copy was noise.
    expect(files.find((f) => f.path === ".metaobjects/CLAUDE.md")).toBeUndefined();
    expect(agents.contents).not.toContain("{{stackLine}}");
    expect(agents.contents).not.toContain("{{codegenCommand}}");
    expect(agents.contents).toContain("npx meta gen");
    expect(agents.contents.toLowerCase()).toContain("typescript");
    expect(agents.contents.toLowerCase()).toContain("react");
  });

  test("the working loop names only the generate steps THIS stack's toolchain has", () => {
    // The loop is the first thing an agent reads, so a step for a toolchain the project does
    // not use is worse than none: a Python project told to edit metaobjects.config.ts. One
    // fragment per declared server, plus the web client's when a client is declared.
    const onAgents = (servers: string[], clients: string[]): string =>
      assemble({ contentRoot: CONTENT_ROOT, stack: makeStack(servers as never, clients as never) })
        .find((f) => f.path === ".metaobjects/AGENTS.md")!.contents;

    const node = onAgents(["typescript"], []);
    expect(node).toContain("### TypeScript: generate with `npx meta gen`");
    expect(node).toContain('import { entityFile, namesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";');
    expect(node).toContain("requirementTests()");
    expect(node).toContain("`npx meta verify --codegen`");
    expect(node).not.toContain("metaobjects.config.yaml");
    expect(node).not.toContain("### Web client");

    const python = onAgents(["python"], []);
    expect(python).toContain("### Python: generate with `metaobjects gen`");
    expect(python).toContain("`metaobjects verify`");
    expect(python).not.toContain("metaobjects.config.ts");
    expect(python).not.toContain("npx meta gen`");

    const java = onAgents(["java"], []);
    expect(java).toContain("`mvn metaobjects:generate`");
    // The generator class list lives in the codegen skill; the loop points at it.
    expect(java).toContain("`metaobjects-codegen` skill's `references/java.md`");
    expect(java).not.toContain("### Kotlin");

    // A polyglot stack gets each declared port, in SERVER_LANGS order, and the client step.
    const jvmReact = onAgents(["kotlin", "java"], ["react"]);
    expect(jvmReact.indexOf("### Java:")).toBeLessThan(jvmReact.indexOf("### Kotlin:"));
    expect(jvmReact).toContain("### Web client");
    expect(jvmReact).toContain("`npx meta verify --codegen` (the generated web client)");
    // Java and Kotlin share one verify goal: listed once. Each fragment starts its own block.
    expect(jvmReact.split("- `mvn metaobjects:verify`").length).toBe(2);
    expect(jvmReact).not.toMatch(/[^\n]\n### /);

    // The schema step is the Node CLI on every stack, and names the rename and allow flags.
    for (const c of [node, python, java, jvmReact]) {
      expect(c).toContain("npx meta migrate --from-db --db <url>");
      expect(c).toContain("--rename-column <table>.<old_column>=<new_column>");
      expect(c).toContain("--allow drop-check");
      expect(c).not.toContain("{{");
    }

    // No declared server: the loop says how to declare one rather than guessing.
    expect(onAgents([], [])).toContain("meta init --docs-only --refresh-docs --server");
  });

  test("the always-on loads skills by name, and offers a path only to assistants that cannot", () => {
    // Skills are loaded by name; reading SKILL.md by path bypasses that and costs the whole
    // file. The one path the text gives is the fallback for an assistant with no skill
    // loading, which would otherwise have no way in.
    const c = assemble({ contentRoot: CONTENT_ROOT, stack: makeStack(["typescript"], ["react"]) })
      .find((f) => f.path === ".metaobjects/AGENTS.md")!.contents;
    expect(c.match(/SKILL\.md/g)?.length).toBe(1);
    expect(c).toContain("load a `metaobjects-*` skill by name, or open\n`.claude/skills/<skill>/SKILL.md` if your assistant does not load skills");
    expect(c).not.toMatch(/\bcat\b/);
    expect(c).toContain("The loop above needs no skill.");
  });

  test("--skills-dir moves every skill file and the always-on names the chosen directory", () => {
    const files = assemble({ contentRoot: CONTENT_ROOT, stack: makeStack(["python"], []), skillsDir: "./.agents/skills/" });
    const skillPaths = files.map((f) => f.path).filter((p) => p.endsWith(".md") && !p.startsWith(".metaobjects/"));
    expect(skillPaths.length).toBeGreaterThan(0);
    for (const p of skillPaths) expect(p.startsWith(".agents/skills/metaobjects-")).toBe(true);
    const c = files.find((f) => f.path === ".metaobjects/AGENTS.md")!.contents;
    expect(c).toContain("`.agents/skills/<skill>/SKILL.md`");
    expect(c).not.toContain(".claude/skills");
  });

  test("a skills directory outside the project is refused", () => {
    for (const bad of ["/abs/skills", "../skills", "a/../../b", "", "C:/skills"]) {
      expect(() => assemble({ contentRoot: CONTENT_ROOT, stack: makeStack([], []), skillsDir: bad })).toThrow(/--skills-dir/);
    }
  });

  test("the always-on states the REST conventions agents trip on", () => {
    const c = assemble({ contentRoot: CONTENT_ROOT, stack: makeStack(["java"], []) })
      .find((f) => f.path === ".metaobjects/AGENTS.md")!.contents;
    expect(c).toContain("`?filter[status][eq]=active`, never\n  `?status=active`");
    for (const op of ["`eq`", "`ne`", "`isNull`", "`in`", "`like`", "`gt`", "`gte`", "`lt`", "`lte`"]) expect(c).toContain(op);
    expect(c).toContain("`?limit=N&offset=N`");
    expect(c).toContain("`invalid_sort`");
    expect(c).toContain("so Java, Kotlin, C# and Python projects need Node too");
  });

  test("a malformed section tag THROWS rather than shipping into a file an agent reads", () => {
    // The mechanism resolves sections in one non-greedy pass, so a mistyped close tag, an
    // unclosed section and a nested pair all leave a literal `{{#…}}` behind. Passing that
    // through would put a broken tag into AGENTS.md — the exact failure this surface
    // exists to prevent — so a leftover tag is an error. Exercised through a temp content
    // root rather than the shipped template, which is (and must stay) well-formed.
    const root = mkdtempSync(join(tmpdir(), "assemble-tpl-"));
    try {
      cpSync(CONTENT_ROOT, root, { recursive: true });
      const tpl = join(root, "templates", "always-on.md.mustache");
      const good = readFileSync(tpl, "utf8");
      for (const broken of [
        `${good}\n{{#someSection}}\nbody\n{{/someSections}}\n`, // mistyped close
        `${good}\n{{#someSection}}\nunclosed\n`, // never closed
      ]) {
        writeFileSync(tpl, broken);
        expect(() =>
          assemble({ contentRoot: root, stack: makeStack(["typescript"], []) }),
        ).toThrow(/unresolved template section tag/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stack-scoped: installs only the stack's language/framework reference fragments", () => {
    const stack = makeStack(["typescript"], ["react"]); // a narrow stack...
    const p = paths(assemble({ contentRoot: CONTENT_ROOT, stack }));
    // ...gets only its own language's codegen reference, not the others:
    expect(p).toContain(".claude/skills/metaobjects-codegen/references/typescript.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/java.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/kotlin.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/csharp.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/python.md");
    // ...its client ref, not the client frameworks it doesn't use:
    expect(p).toContain(".claude/skills/metaobjects-runtime-ui/references/react.md");
    expect(p).not.toContain(".claude/skills/metaobjects-runtime-ui/references/tanstack.md");
    // universal (non-language) fragments always install:
    expect(p).toContain(".claude/skills/metaobjects-verify/references/migration.md");
    expect(p).toContain(".claude/skills/metaobjects-audit/references/capability-checklist.md");
    for (const s of ["authoring", "codegen", "runtime-ui", "prompts", "verify"]) {
      expect(p).toContain(`.claude/skills/metaobjects-${s}/SKILL.md`);
    }
  });

  test("a `<token>-<topic>.md` fragment is scoped by its token, like `<token>.md`", () => {
    // A language reference too long to read whole splits into `typescript.md` plus topic
    // files such as `typescript-retargeting.md`. Without this rule a hyphenated name is not
    // a stack token, so it installed into every stack: TypeScript prose in a Java project.
    const root = mkdtempSync(join(tmpdir(), "assemble-scoped-topic-"));
    try {
      cpSync(CONTENT_ROOT, root, { recursive: true });
      const refs = join(root, "skills", "metaobjects-codegen", "references");
      writeFileSync(join(refs, "typescript-zz-topic.md"), "# ts topic\n");
      writeFileSync(join(refs, "zz-universal-topic.md"), "# universal\n");
      const ts = paths(assemble({ contentRoot: root, stack: makeStack(["typescript"], []) }));
      const java = paths(assemble({ contentRoot: root, stack: makeStack(["java"], []) }));
      const topic = ".claude/skills/metaobjects-codegen/references/typescript-zz-topic.md";
      const universal = ".claude/skills/metaobjects-codegen/references/zz-universal-topic.md";
      expect(ts).toContain(topic);
      expect(java).not.toContain(topic);
      expect(ts).toContain(universal);
      expect(java).toContain(universal);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a java-only stack gets its java references, not other languages or unused clients", () => {
    const p = paths(assemble({ contentRoot: CONTENT_ROOT, stack: makeStack(["java"], []) }));
    expect(p).toContain(".claude/skills/metaobjects-codegen/references/java.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/typescript.md");
    // its language fragment in every skill that has one:
    expect(p).toContain(".claude/skills/metaobjects-runtime-ui/references/java.md");
    // no client in the stack → no client-framework refs:
    expect(p).not.toContain(".claude/skills/metaobjects-runtime-ui/references/react.md");
    expect(p).not.toContain(".claude/skills/metaobjects-runtime-ui/references/tanstack.md");
    // universal fragments still present:
    expect(p).toContain(".claude/skills/metaobjects-verify/references/migration.md");
  });

  test("a kotlin-primary stack assembles without throwing and uses the kotlin codegen command", () => {
    const stack = makeStack(["kotlin"], []);
    const files = assemble({ contentRoot: CONTENT_ROOT, stack });
    const agents = files.find((f) => f.path === ".metaobjects/AGENTS.md")!;
    expect(agents.contents.toLowerCase()).toContain("kotlin");
    expect(agents.contents).toContain("mvn metaobjects:generate");
  });

  test("a stack whose primary server has no meta file falls back to a default codegen command (no throw)", () => {
    // csharp.meta.json exists now, but the guard must not throw even if a meta file were absent.
    const stack = makeStack(["csharp"], []);
    expect(() => assemble({ contentRoot: CONTENT_ROOT, stack })).not.toThrow();
  });

  test("the requirements pages install in every stack, whatever the model declares", () => {
    // They used to be gated on a `requirement.*` node observed at `meta init`, which is before
    // a new project has written any: the project that later declared requirements never got
    // the pages its skills point to.
    for (const stack of [makeStack(["typescript"], []), makeStack(["python"], []), makeStack([], [])]) {
      const p = paths(assemble({ contentRoot: CONTENT_ROOT, stack }));
      expect(p).toContain(".claude/skills/metaobjects-authoring/references/requirements.md");
      expect(p).toContain(".claude/skills/metaobjects-verify/references/requirements.md");
      expect(p).toContain(".claude/skills/metaobjects-audit/references/requirements.md");
    }
  });

  test("output is deterministic (stable order + identical across runs)", () => {
    const stack = makeStack(["typescript"], ["react"]);
    const a = assemble({ contentRoot: CONTENT_ROOT, stack });
    const b = assemble({ contentRoot: CONTENT_ROOT, stack });
    expect(a).toEqual(b);
    expect(a.map((f) => f.path)).toEqual([...a.map((f) => f.path)].sort());
  });
});
