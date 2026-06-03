# Agent-Context P0 — Foundation (pipeline + gates) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `agent-context/` content tree and the TypeScript assembler/stack-resolver/conformance machinery that turns it into the scaffolded surfaces (the slim always-on Markdown + the five Claude skills with only the project's language reference fragments), proven end-to-end against a real seed stack.

**Architecture:** A repo-root `agent-context/` source tree holds the universal templates, per-server meta, and the five skills (each a universal `SKILL.md` plus `references/<token>.md` fragments). A pure stack-resolver normalizes/detects the project's server+client axes into a token set. A pure assembler reads the source and emits the consumer files, installing a reference fragment **iff** its token is in the resolved stack (`"migration"` is always a token). A byte-exact conformance corpus pins the assembled output; a vocabulary drift test pins the content against the canonical metamodel constants; a size gate keeps the always-on cheap. This plan delivers the machinery + a real seed of content; deepening every language's fragments and the `core/` concept reference is the follow-on content plan.

**Tech Stack:** TypeScript (ESM), Bun test runner, `@metaobjectsdev/sdk` package (`src/agent-context/`), `@metaobjectsdev/metadata` (constants), `fixtures/agent-context-conformance/` corpus. No new runtime dependencies.

---

## Scope note

This is the foundation slice of spec `docs/superpowers/specs/2026-06-02-downstream-agent-context-design.md` (phase **P0**, trimmed to the smallest end-to-end-testable unit). **In scope:** the source-tree skeleton, server-meta, the always-on template, the five `SKILL.md` bodies, the reference fragments needed to prove selection (`typescript`+`java` servers, `react`+`tanstack` clients, `migration`), the stack-resolver, the assembler, the drift test, the conformance corpus + runner, and the always-on size gate. **Deferred to the follow-on content plan:** the `core/` consolidated concept reference, the remaining server references (`kotlin`/`csharp`/`python`) and the `angular` client reference, and (to P3) the `llms.txt`/`llms-full.txt` templates. **Deferred to P1+:** wiring any port's `init` command to call the assembler.

## File Structure

**Content source (repo root, new):**
- `agent-context/README.md` — what this tree is + the assembler contract (one paragraph).
- `agent-context/servers/<lang>.meta.json` — tiny structured per-server meta (`displayName`, `install`, `codegenCommand`) for the always-on stack line + codegen command. P0: `typescript`, `java`.
- `agent-context/templates/always-on.md.mustache` — the slim always-on body with `{{stackLine}}` + `{{codegenCommand}}` variables.
- `agent-context/skills/metaobjects-authoring/SKILL.md` — universal; no references.
- `agent-context/skills/metaobjects-codegen/{SKILL.md, references/{typescript,java}.md}`.
- `agent-context/skills/metaobjects-runtime-ui/{SKILL.md, references/{typescript,java,react,tanstack}.md}`.
- `agent-context/skills/metaobjects-prompts/{SKILL.md, references/{typescript,java}.md}`.
- `agent-context/skills/metaobjects-verify/{SKILL.md, references/migration.md}`.

**Machinery (TypeScript, in `@metaobjectsdev/sdk`):**
- `server/typescript/packages/sdk/src/agent-context/types.ts` — `ServerLang`, `ClientFramework`, `Stack`, `AssembledFile`, the closed-set arrays, the skill list.
- `server/typescript/packages/sdk/src/agent-context/resolve.ts` — `makeStack`, `detectStack`, `ProjectProbe`.
- `server/typescript/packages/sdk/src/agent-context/assemble.ts` — `assemble`.
- `server/typescript/packages/sdk/src/agent-context/index.ts` — public surface.
- `server/typescript/packages/sdk/src/index.ts` — add `export * from "./agent-context/index.js"` (verify path).

**Tests (in `@metaobjectsdev/sdk`):**
- `server/typescript/packages/sdk/test/agent-context/resolve.test.ts`
- `server/typescript/packages/sdk/test/agent-context/assemble.test.ts`
- `server/typescript/packages/sdk/test/agent-context/drift.test.ts`
- `server/typescript/packages/sdk/test/agent-context/size-gate.test.ts`
- `server/typescript/packages/sdk/test/agent-context-conformance.test.ts` — at `test/` root so the corpus relative path matches `render/test/`'s 5-ups.

**Conformance corpus (repo root, new):**
- `fixtures/agent-context-conformance/<stack-name>/stack.json` + `expected/<relative-path>` golden files.

---

### Task 1: Module skeleton + types

**Files:**
- Create: `server/typescript/packages/sdk/src/agent-context/types.ts`
- Create: `server/typescript/packages/sdk/src/agent-context/index.ts`
- Modify: `server/typescript/packages/sdk/src/index.ts`
- Test: `server/typescript/packages/sdk/test/agent-context/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-context/types.test.ts
import { test, expect, describe } from "bun:test";
import { SERVER_LANGS, CLIENT_FRAMEWORKS, SKILL_NAMES, MIGRATION_TOKEN } from "../../src/agent-context/types.js";

describe("agent-context types", () => {
  test("closed sets have the expected members", () => {
    expect([...SERVER_LANGS]).toEqual(["typescript", "java", "kotlin", "csharp", "python"]);
    expect([...CLIENT_FRAMEWORKS]).toEqual(["react", "tanstack", "angular"]);
    expect(MIGRATION_TOKEN).toBe("migration");
  });
  test("the five skills are named and ordered", () => {
    expect(SKILL_NAMES).toEqual([
      "metaobjects-authoring",
      "metaobjects-codegen",
      "metaobjects-runtime-ui",
      "metaobjects-prompts",
      "metaobjects-verify",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/sdk && bun test test/agent-context/types.test.ts`
Expected: FAIL — cannot find module `../../src/agent-context/types.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/agent-context/types.ts
export const SERVER_LANGS = ["typescript", "java", "kotlin", "csharp", "python"] as const;
export type ServerLang = (typeof SERVER_LANGS)[number];

export const CLIENT_FRAMEWORKS = ["react", "tanstack", "angular"] as const;
export type ClientFramework = (typeof CLIENT_FRAMEWORKS)[number];

/** Always-present token: schema migrations are TS-owned for every port (ADR-0015). */
export const MIGRATION_TOKEN = "migration";

export const SKILL_NAMES = [
  "metaobjects-authoring",
  "metaobjects-codegen",
  "metaobjects-runtime-ui",
  "metaobjects-prompts",
  "metaobjects-verify",
] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

/** The resolved tech-stack of a consumer project. */
export interface Stack {
  servers: ServerLang[];        // deduped, in SERVER_LANGS order
  clients: ClientFramework[];   // deduped, in CLIENT_FRAMEWORKS order
  /** servers ∪ clients ∪ {"migration"} — the install-selection set for reference fragments. */
  tokens: ReadonlySet<string>;
}

/** A file the assembler emits, path relative to the consumer project root. */
export interface AssembledFile {
  path: string;       // e.g. ".metaobjects/AGENTS.md", ".claude/skills/metaobjects-codegen/references/java.md"
  contents: string;
}
```

```ts
// src/agent-context/index.ts
export * from "./types.js";
export * from "./resolve.js";
export * from "./assemble.js";
```

> Note: `index.ts` references `resolve.js`/`assemble.js` created in Tasks 2 and 7. Until then, comment out those two re-export lines OR create empty stubs; re-enable in Task 7. To keep this task green, create the two files as empty `export {};` stubs now.

Create the stubs:

```ts
// src/agent-context/resolve.ts
export {};
```

```ts
// src/agent-context/assemble.ts
export {};
```

Add to `src/index.ts` (verify the existing export list; append):

```ts
export * from "./agent-context/index.js";
```

- [ ] **Step 4: Run test + typecheck to verify they pass**

Run: `cd server/typescript/packages/sdk && bun test test/agent-context/types.test.ts && bun run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/sdk/src/agent-context/types.ts \
        server/typescript/packages/sdk/src/agent-context/index.ts \
        server/typescript/packages/sdk/src/agent-context/resolve.ts \
        server/typescript/packages/sdk/src/agent-context/assemble.ts \
        server/typescript/packages/sdk/src/index.ts \
        server/typescript/packages/sdk/test/agent-context/types.test.ts
git commit -m "feat(agent-context): types skeleton (server/client/token vocab + skill names)"
```

---

### Task 2: Stack resolver

**Files:**
- Modify: `server/typescript/packages/sdk/src/agent-context/resolve.ts`
- Test: `server/typescript/packages/sdk/test/agent-context/resolve.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-context/resolve.test.ts
import { test, expect, describe } from "bun:test";
import { makeStack, detectStack, type ProjectProbe } from "../../src/agent-context/resolve.js";

const probe = (deps: string[], files: string[]): ProjectProbe => ({
  hasDep: (name) => deps.includes(name),
  hasFileMatching: (re) => files.some((f) => re.test(f)),
});

describe("makeStack", () => {
  test("dedupes, orders, and computes tokens incl. migration", () => {
    const s = makeStack(["java", "typescript", "java"], ["tanstack", "react"]);
    expect(s.servers).toEqual(["typescript", "java"]);   // SERVER_LANGS order
    expect(s.clients).toEqual(["react", "tanstack"]);     // CLIENT_FRAMEWORKS order
    expect([...s.tokens].sort()).toEqual(["java", "migration", "react", "tanstack", "typescript"]);
  });
  test("empty stack still carries the migration token", () => {
    expect([...makeStack([], []).tokens]).toEqual(["migration"]);
  });
});

describe("detectStack", () => {
  test("detects a TS server + react/tanstack clients from deps", () => {
    const r = detectStack(probe(["@metaobjectsdev/cli", "@metaobjectsdev/react", "@metaobjectsdev/tanstack"], ["package.json"]));
    expect(r.servers).toEqual(["typescript"]);
    expect(r.clients.sort()).toEqual(["react", "tanstack"]);
  });
  test("detects a Java server + react client (the polyglot case)", () => {
    const r = detectStack(probe(["@metaobjectsdev/react"], ["pom.xml"]));
    expect(r.servers).toEqual(["java"]);
    expect(r.clients).toEqual(["react"]);
  });
  test("detects kotlin via gradle, csharp via csproj, python via pyproject", () => {
    expect(detectStack(probe([], ["build.gradle.kts"])).servers).toEqual(["kotlin"]);
    expect(detectStack(probe([], ["Api.csproj"])).servers).toEqual(["csharp"]);
    expect(detectStack(probe([], ["pyproject.toml"])).servers).toEqual(["python"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/sdk && bun test test/agent-context/resolve.test.ts`
Expected: FAIL — `makeStack`/`detectStack` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/agent-context/resolve.ts
import {
  SERVER_LANGS, CLIENT_FRAMEWORKS, MIGRATION_TOKEN,
  type ServerLang, type ClientFramework, type Stack,
} from "./types.js";

export interface ProjectProbe {
  hasDep(name: string): boolean;
  hasFileMatching(pattern: RegExp): boolean;
}

export function makeStack(servers: ServerLang[], clients: ClientFramework[]): Stack {
  const s = SERVER_LANGS.filter((x) => servers.includes(x));
  const c = CLIENT_FRAMEWORKS.filter((x) => clients.includes(x));
  return { servers: s, clients: c, tokens: new Set<string>([...s, ...c, MIGRATION_TOKEN]) };
}

/** Best-effort detection from a project probe. Always overridable; a wrong guess
 * writes an extra fragment, never a wrong one (callers confirm before scaffolding). */
export function detectStack(probe: ProjectProbe): { servers: ServerLang[]; clients: ClientFramework[] } {
  const servers: ServerLang[] = [];
  if (probe.hasDep("@metaobjectsdev/cli") || probe.hasDep("@metaobjectsdev/codegen-ts")) servers.push("typescript");
  if (probe.hasFileMatching(/(^|\/)build\.gradle(\.kts)?$/)) servers.push("kotlin");
  if (probe.hasFileMatching(/(^|\/)pom\.xml$/)) servers.push("java");
  if (probe.hasFileMatching(/\.csproj$/)) servers.push("csharp");
  if (probe.hasFileMatching(/(^|\/)(pyproject\.toml|setup\.py)$/)) servers.push("python");

  const clients: ClientFramework[] = [];
  if (probe.hasDep("@metaobjectsdev/react")) clients.push("react");
  if (probe.hasDep("@metaobjectsdev/tanstack")) clients.push("tanstack");
  if (probe.hasDep("@metaobjectsdev/angular")) clients.push("angular");

  return { servers, clients };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/sdk && bun test test/agent-context/resolve.test.ts && bun run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/sdk/src/agent-context/resolve.ts \
        server/typescript/packages/sdk/test/agent-context/resolve.test.ts
git commit -m "feat(agent-context): stack resolver (makeStack + manifest detection)"
```

---

### Task 3: Server meta files

**Files:**
- Create: `agent-context/servers/typescript.meta.json`
- Create: `agent-context/servers/java.meta.json`
- Create: `agent-context/README.md`

- [ ] **Step 1: Write the content (no test — validated by the assembler test in Task 7)**

`agent-context/servers/typescript.meta.json`:

```json
{
  "displayName": "TypeScript",
  "install": "npm install -D @metaobjectsdev/cli @metaobjectsdev/codegen-ts",
  "codegenCommand": "npx meta gen"
}
```

`agent-context/servers/java.meta.json`:

```json
{
  "displayName": "Java",
  "install": "add com.metaobjects:metaobjects-metadata + metaobjects-codegen-spring + metaobjects-maven-plugin to your pom.xml",
  "codegenCommand": "mvn meta:gen"
}
```

`agent-context/README.md`:

```markdown
# agent-context — source of truth for downstream AI-assistant context

This tree is the single source the assembler (`@metaobjectsdev/sdk`,
`src/agent-context/`) turns into the files scaffolded into a consumer project:
the slim always-on Markdown (`.metaobjects/AGENTS.md` + `CLAUDE.md`) and the five
`metaobjects-*` Claude skills (each a universal `SKILL.md` plus the
`references/<token>.md` fragments matching the project's resolved stack).

- `servers/<lang>.meta.json` — per-server install + codegen command (drives the always-on).
- `templates/always-on.md.mustache` — the slim always-on body (`{{stackLine}}`, `{{codegenCommand}}`).
- `skills/<skill>/SKILL.md` — universal skill body.
- `skills/<skill>/references/<token>.md` — language fragment; installed iff `<token>` is in the stack.

Design: `docs/superpowers/specs/2026-06-02-downstream-agent-context-design.md`.
```

- [ ] **Step 2: Validate JSON parses**

Run: `cd /` then from repo root: `node -e "JSON.parse(require('fs').readFileSync('agent-context/servers/typescript.meta.json')); JSON.parse(require('fs').readFileSync('agent-context/servers/java.meta.json')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add agent-context/servers/typescript.meta.json agent-context/servers/java.meta.json agent-context/README.md
git commit -m "feat(agent-context): server meta (typescript, java) + tree README"
```

---

### Task 4: Always-on template

**Files:**
- Create: `agent-context/templates/always-on.md.mustache`

- [ ] **Step 1: Write the content**

Author the slim always-on body per spec § "Surface 1". Keep it **≤ 120 lines** (enforced by Task 10). It MUST contain, in order: the `{{stackLine}}` line; ≤5 working principles; "Metadata lives in `metaobjects/`; regenerate with `{{codegenCommand}}`"; the two violation rules (attribute uniqueness; `@attr` inline/child duality); package-path notation (`::`); and the skill pointer. Use **only** the fused-key canonical form in any example (`{"object.entity": {...}}`) — never the retired `{object:{subType:...}}` form (the drift test in Task 8 fails otherwise).

`agent-context/templates/always-on.md.mustache` (starting point — extend the prose, keep the two variables and the canonical examples):

```markdown
# Working with MetaObjects in this project

> {{stackLine}}

MetaObjects is a metadata standard: typed metadata in `metaobjects/` is the durable
spine; generated code is the disposable artifact. Regenerate with `{{codegenCommand}}`.

## Principles
- Pattern-derivable from metadata = codegen, never hand-write (FKs, CRUD, validators, finders).
- Never hand-edit generated files — change the metadata and regenerate (three-way merge preserves hand-written regions).
- Use the generated constants for any string that names metadata.

## Authoring rules you must not violate
- Nodes are fused-key maps: `{"<type>.<subType>": { ... }}` (e.g. `{"field.string": {"name": "email"}}`). Never `{"field": {"subType": "string"}}`.
- Attribute names are unique within a node; for multi-value use one array attr (`@values: [...]`).
- An inline `@maxLength: 50` equals an `attr` child of the same name — never write both.
- Package paths use `::` (`acme::common::id`).

## Going deeper (Claude Code)
For authoring, codegen, runtime/UI, prompts, or verify work, use the matching
`metaobjects-*` skill — its body links the `references/<lang>.md` fragment installed
for this project's stack.
```

- [ ] **Step 2: Commit**

```bash
git add agent-context/templates/always-on.md.mustache
git commit -m "feat(agent-context): slim always-on template (stack line + codegen var)"
```

---

### Task 5: The five SKILL.md bodies

**Files:**
- Create: `agent-context/skills/metaobjects-authoring/SKILL.md`
- Create: `agent-context/skills/metaobjects-codegen/SKILL.md`
- Create: `agent-context/skills/metaobjects-runtime-ui/SKILL.md`
- Create: `agent-context/skills/metaobjects-prompts/SKILL.md`
- Create: `agent-context/skills/metaobjects-verify/SKILL.md`

- [ ] **Step 1: Author each `SKILL.md`** (universal body, ≤ ~500 lines each). Every file MUST begin with YAML frontmatter:

```markdown
---
name: <skill-name>
description: <the exact description from the spec's Surface 2 table>
---
```

Use the **exact `description` strings** from spec § "Surface 2" (they are the trigger text). Body coverage per skill, drawn from the spec's *Design-information coverage* appendix and authored **only in the fused-key canonical form**:

- `metaobjects-authoring` — fused-key encoding; the two violation rules; field subtypes (string/int/long/double/boolean/date/timestamp/decimal/currency/enum/uuid/object); YAML sigil-free desugar + the quote-your-scalars coercion footgun; identities/relationships (`@onDelete`/`@onUpdate`); `source.rdb` + `@kind` + `@table`/`@column`; abstracts/`extends`/`overlay`. **No `references/`** (universal). Add the optional line: "For non-trivial schema design, use `/superpowers:brainstorming` if installed; otherwise proceed."
- `metaobjects-codegen` — config/generators/targets/dialects, `@generated` header + never-hand-edit + three-way merge, stable generator names. Body ends: "For this project's server-language specifics, read `references/<server>.md`." (fragments in Task 6).
- `metaobjects-runtime-ui` — runtime return-type contract (native types); param-passing repo helpers (no `db` singleton); REST contract (URL grammar, filter operators by subtype, sort, limit/offset, currency=minor-units wire); EntityFetcher. Body ends: "For server runtime specifics read `references/<server>.md`; for the web client read `references/<client>.md`."
- `metaobjects-prompts` — `template.prompt`/`output` (`@payloadRef`/`@textRef`/`@format`), payload = `object.value` projection (`origin.*`), provider-resolved text, `render()` determinism, `verify --templates`, parser-on-receipt. Body ends: "For this project's server parser specifics read `references/<server>.md`."
- `metaobjects-verify` — drift sources, `verify --db/--codegen/--templates`, migrations are the TS engine for every port. Body ends: "For the migration tooling read `references/migration.md`."

- [ ] **Step 2: Verify every SKILL.md has valid frontmatter**

Run from repo root: `for f in agent-context/skills/*/SKILL.md; do head -1 "$f" | grep -q '^---$' && grep -q '^name:' "$f" && grep -q '^description:' "$f" && echo "ok $f" || echo "BAD $f"; done`
Expected: five `ok` lines, no `BAD`.

- [ ] **Step 3: Commit**

```bash
git add agent-context/skills/*/SKILL.md
git commit -m "feat(agent-context): five universal skill bodies (authoring/codegen/runtime-ui/prompts/verify)"
```

---

### Task 6: Seed reference fragments (proves selection)

**Files:**
- Create: `agent-context/skills/metaobjects-codegen/references/typescript.md`
- Create: `agent-context/skills/metaobjects-codegen/references/java.md`
- Create: `agent-context/skills/metaobjects-runtime-ui/references/typescript.md`
- Create: `agent-context/skills/metaobjects-runtime-ui/references/java.md`
- Create: `agent-context/skills/metaobjects-runtime-ui/references/react.md`
- Create: `agent-context/skills/metaobjects-runtime-ui/references/tanstack.md`
- Create: `agent-context/skills/metaobjects-prompts/references/typescript.md`
- Create: `agent-context/skills/metaobjects-prompts/references/java.md`
- Create: `agent-context/skills/metaobjects-verify/references/migration.md`

- [ ] **Step 1: Author each fragment** (self-contained; the consumer has no `docs/`). Each filename's stem is its **token**. Coverage:
  - `codegen/typescript.md` — `metaobjects.config.ts` shape, the `generators` array (`entityFile`/`queriesFile`/`routesFile`/`barrel`), `dialect`, `meta gen`/`--watch`.
  - `codegen/java.md` — Maven plugin `meta:gen`; `codegen-spring` controller/DTO/repository output; Maven coords.
  - `runtime-ui/typescript.md` — `runtime-ts` ObjectManager + Kysely/Drizzle; generated `<Entity>.queries.ts` helpers take `db` first.
  - `runtime-ui/java.md` — OMDB `ObjectManagerDb` (`persist`/`getObjectById`/`getObjectsBy`); Spring-tx.
  - `runtime-ui/react.md` — `@metaobjectsdev/react` (`useEntityForm`, `CurrencyInput`); pairs with `codegen-ts-react`.
  - `runtime-ui/tanstack.md` — `@metaobjectsdev/tanstack` (`EntityFetcherProvider`, `EntityGrid`); pairs with `codegen-ts-tanstack`.
  - `prompts/typescript.md` — TS parser-on-receipt API (`parse`/`safeParse`) for `template.output`.
  - `prompts/java.md` — Java parser API (`parseX`) from `codegen-spring`.
  - `verify/migration.md` — the Node `meta migrate` / `migrate-ts` workflow (generate → review up/down → apply → rollback); applies to every server language (ADR-0015).

- [ ] **Step 2: Verify all nine fragments exist and are non-empty**

Run from repo root: `for f in agent-context/skills/metaobjects-codegen/references/{typescript,java}.md agent-context/skills/metaobjects-runtime-ui/references/{typescript,java,react,tanstack}.md agent-context/skills/metaobjects-prompts/references/{typescript,java}.md agent-context/skills/metaobjects-verify/references/migration.md; do test -s "$f" && echo "ok $f" || echo "MISSING $f"; done`
Expected: nine `ok` lines.

- [ ] **Step 3: Commit**

```bash
git add agent-context/skills/*/references/*.md
git commit -m "feat(agent-context): seed reference fragments (ts+java servers, react+tanstack clients, migration)"
```

---

### Task 7: The assembler

**Files:**
- Modify: `server/typescript/packages/sdk/src/agent-context/assemble.ts`
- Test: `server/typescript/packages/sdk/test/agent-context/assemble.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-context/assemble.test.ts
import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { assemble } from "../../src/agent-context/assemble.js";
import { makeStack } from "../../src/agent-context/resolve.js";

const CONTENT_ROOT = join(import.meta.dir, "../../../../../../agent-context"); // test/agent-context/ → repo root is 6 levels up

function paths(files: { path: string }[]): string[] {
  return files.map((f) => f.path).sort();
}

describe("assemble", () => {
  test("emits AGENTS.md + CLAUDE.md with the stack line + codegen command substituted", () => {
    const stack = makeStack(["typescript"], ["react"]);
    const files = assemble({ contentRoot: CONTENT_ROOT, stack });
    const agents = files.find((f) => f.path === ".metaobjects/AGENTS.md")!;
    const claude = files.find((f) => f.path === ".metaobjects/CLAUDE.md")!;
    expect(agents).toBeDefined();
    expect(claude.contents).toBe(agents.contents);                 // same body
    expect(agents.contents).not.toContain("{{stackLine}}");        // substituted
    expect(agents.contents).not.toContain("{{codegenCommand}}");
    expect(agents.contents).toContain("npx meta gen");             // typescript codegenCommand
    expect(agents.contents.toLowerCase()).toContain("typescript"); // stack line names the server
    expect(agents.contents.toLowerCase()).toContain("react");
  });

  test("installs a reference fragment IFF its token is in the stack", () => {
    const stack = makeStack(["typescript"], ["react"]);   // tokens: typescript, react, migration
    const p = paths(assemble({ contentRoot: CONTENT_ROOT, stack }));
    // codegen: typescript ref installed, java ref excluded
    expect(p).toContain(".claude/skills/metaobjects-codegen/references/typescript.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/java.md");
    // runtime-ui: typescript + react installed; java + tanstack excluded
    expect(p).toContain(".claude/skills/metaobjects-runtime-ui/references/typescript.md");
    expect(p).toContain(".claude/skills/metaobjects-runtime-ui/references/react.md");
    expect(p).not.toContain(".claude/skills/metaobjects-runtime-ui/references/java.md");
    expect(p).not.toContain(".claude/skills/metaobjects-runtime-ui/references/tanstack.md");
    // verify: migration always installed
    expect(p).toContain(".claude/skills/metaobjects-verify/references/migration.md");
    // every skill body is emitted
    for (const s of ["authoring", "codegen", "runtime-ui", "prompts", "verify"]) {
      expect(p).toContain(`.claude/skills/metaobjects-${s}/SKILL.md`);
    }
    // authoring has no references dir entries
    expect(p.some((x) => x.startsWith(".claude/skills/metaobjects-authoring/references/"))).toBe(false);
  });

  test("a java+react stack installs java (not typescript) server refs + react (not tanstack)", () => {
    const p = paths(assemble({ contentRoot: CONTENT_ROOT, stack: makeStack(["java"], ["react"]) }));
    expect(p).toContain(".claude/skills/metaobjects-codegen/references/java.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/typescript.md");
    expect(p).toContain(".claude/skills/metaobjects-runtime-ui/references/react.md");
    expect(p).not.toContain(".claude/skills/metaobjects-runtime-ui/references/tanstack.md");
  });

  test("output is deterministic (stable order + identical across runs)", () => {
    const stack = makeStack(["typescript"], ["react"]);
    const a = assemble({ contentRoot: CONTENT_ROOT, stack });
    const b = assemble({ contentRoot: CONTENT_ROOT, stack });
    expect(a).toEqual(b);
    expect(a.map((f) => f.path)).toEqual([...a.map((f) => f.path)].sort()); // already sorted
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/sdk && bun test test/agent-context/assemble.test.ts`
Expected: FAIL — `assemble` not exported.

- [ ] **Step 3: Write the implementation**

```ts
// src/agent-context/assemble.ts
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { SKILL_NAMES, type AssembledFile, type Stack } from "./types.js";

interface ServerMeta { displayName: string; install: string; codegenCommand: string; }

function readServerMeta(contentRoot: string, server: string): ServerMeta {
  return JSON.parse(readFileSync(join(contentRoot, "servers", `${server}.meta.json`), "utf8")) as ServerMeta;
}

function stackLine(contentRoot: string, stack: Stack): { line: string; codegenCommand: string } {
  const primary = stack.servers[0];
  const meta = primary ? readServerMeta(contentRoot, primary) : undefined;
  const serverPart = stack.servers.length ? stack.servers.join(", ") + " server" : "no server";
  const clientPart = stack.clients.length ? stack.clients.join(", ") + " client" : "no client";
  return {
    line: `Stack: ${serverPart}, ${clientPart}; migrations are TS.`,
    codegenCommand: meta ? meta.codegenCommand : "meta gen",
  };
}

function applyTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    if (!(k in vars)) throw new Error(`agent-context: unknown template variable {{${k}}}`);
    return vars[k]!;
  });
}

/** Assemble the consumer files for a resolved stack. Pure given the content tree. */
export function assemble(opts: { contentRoot: string; stack: Stack }): AssembledFile[] {
  const { contentRoot, stack } = opts;
  const out: AssembledFile[] = [];

  // 1. Always-on (AGENTS.md + CLAUDE.md, identical contents).
  const tpl = readFileSync(join(contentRoot, "templates", "always-on.md.mustache"), "utf8");
  const { line, codegenCommand } = stackLine(contentRoot, stack);
  const alwaysOn = applyTemplate(tpl, { stackLine: line, codegenCommand });
  out.push({ path: ".metaobjects/AGENTS.md", contents: alwaysOn });
  out.push({ path: ".metaobjects/CLAUDE.md", contents: alwaysOn });

  // 2. Skills: body + only the references whose token is in the stack.
  for (const skill of SKILL_NAMES) {
    const skillDir = join(contentRoot, "skills", skill);
    const body = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    out.push({ path: `.claude/skills/${skill}/SKILL.md`, contents: body });

    const refDir = join(skillDir, "references");
    if (existsSync(refDir) && statSync(refDir).isDirectory()) {
      const refs = readdirSync(refDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, ""))
        .filter((token) => stack.tokens.has(token))
        .sort();
      for (const token of refs) {
        out.push({
          path: `.claude/skills/${skill}/references/${token}.md`,
          contents: readFileSync(join(refDir, `${token}.md`), "utf8"),
        });
      }
    }
  }

  // Stable order: by path.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
```

Re-enable the `index.ts` re-exports (they were stubbed in Task 1 — confirm `resolve.js`/`assemble.js` now export real symbols; `src/agent-context/index.ts` already `export *`s them, so no change needed).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/sdk && bun test test/agent-context/assemble.test.ts && bun run typecheck`
Expected: PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/sdk/src/agent-context/assemble.ts \
        server/typescript/packages/sdk/test/agent-context/assemble.test.ts
git commit -m "feat(agent-context): assembler (always-on substitution + token-gated reference selection)"
```

---

### Task 8: Vocabulary drift test (content vs canonical constants)

**Files:**
- Test: `server/typescript/packages/sdk/test/agent-context/drift.test.ts`

This is a test-only guard (no implementation file) — it asserts the shipped content never uses retired or non-existent metamodel vocabulary.

- [ ] **Step 1: Write the test**

```ts
// test/agent-context/drift.test.ts
import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FIELD_SUBTYPES, OBJECT_SUBTYPES, SOURCE_SUBTYPES } from "@metaobjectsdev/metadata";

const CONTENT_ROOT = join(import.meta.dir, "../../../../../../agent-context"); // test/agent-context/ → repo root is 6 levels up

function allMarkdown(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) allMarkdown(p, acc);
    else if (name.endsWith(".md") || name.endsWith(".mustache")) acc.push(p);
  }
  return acc;
}

describe("agent-context vocabulary drift", () => {
  const files = allMarkdown(CONTENT_ROOT);
  const corpus = files.map((f) => ({ f, text: readFileSync(f, "utf8") }));

  test("there is content to check", () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  test("never uses retired tokens (pre-v2 encoding / source subtypes / @dbColumn)", () => {
    // Retired by ADR-0007 (source v2) and the fused-key migration.
    const retired = [/source\.dbTable/, /source\.dbView/, /@dbColumn\b/, /"subType"\s*:/, /\bmerge:\s*true\b/];
    const hits: string[] = [];
    for (const { f, text } of corpus) {
      for (const re of retired) if (re.test(text)) hits.push(`${f} :: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  test("every `field.<subtype>` mentioned is a real FIELD_SUBTYPE", () => {
    const known = new Set<string>(FIELD_SUBTYPES as readonly string[]);
    const bad: string[] = [];
    for (const { f, text } of corpus) {
      for (const m of text.matchAll(/\bfield\.([a-z][a-zA-Z0-9]*)\b/g)) {
        if (!known.has(m[1]!)) bad.push(`${f} :: field.${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("every `object.<subtype>` and `source.<subtype>` mentioned is real", () => {
    const objs = new Set<string>(OBJECT_SUBTYPES as readonly string[]);
    const srcs = new Set<string>(SOURCE_SUBTYPES as readonly string[]);
    const bad: string[] = [];
    for (const { f, text } of corpus) {
      for (const m of text.matchAll(/\bobject\.([a-z][a-zA-Z0-9]*)\b/g)) if (!objs.has(m[1]!)) bad.push(`${f} :: object.${m[1]}`);
      for (const m of text.matchAll(/\bsource\.([a-z][a-zA-Z0-9]*)\b/g)) if (!srcs.has(m[1]!)) bad.push(`${f} :: source.${m[1]}`);
    }
    expect(bad).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd server/typescript/packages/sdk && bun test test/agent-context/drift.test.ts`
Expected: PASS. If it FAILS, the content (Tasks 4–6) used a retired/unknown token — fix the content, not the test. (Confirm `FIELD_SUBTYPES`/`OBJECT_SUBTYPES`/`SOURCE_SUBTYPES` are exported from `@metaobjectsdev/metadata`; they are re-exported via `metadata/src/index.ts` from the `*-constants.ts` modules. If an import name differs, correct it to the real export.)

- [ ] **Step 3: Commit**

```bash
git add server/typescript/packages/sdk/test/agent-context/drift.test.ts
git commit -m "test(agent-context): vocabulary drift guard (no retired tokens; subtypes ⊆ constants)"
```

---

### Task 9: Conformance corpus + runner

**Files:**
- Create: `fixtures/agent-context-conformance/ts-react-tanstack/stack.json`
- Create: `fixtures/agent-context-conformance/ts-react-tanstack/expected/**` (generated)
- Create: `fixtures/agent-context-conformance/java-react/stack.json`
- Create: `fixtures/agent-context-conformance/java-react/expected/**` (generated)
- Test: `server/typescript/packages/sdk/test/agent-context-conformance.test.ts`

- [ ] **Step 1: Write the failing runner**

```ts
// test/agent-context-conformance.test.ts
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { assemble } from "../src/agent-context/assemble.js";
import { makeStack } from "../src/agent-context/resolve.js";
import type { ServerLang, ClientFramework } from "../src/agent-context/types.js";

const CONTENT_ROOT = join(import.meta.dir, "../../../../../agent-context"); // test/ → repo root is 5 levels up
const CORPUS = join(import.meta.dir, "../../../../../fixtures/agent-context-conformance");

interface StackSpec { servers: ServerLang[]; clients: ClientFramework[]; }

function walkExpected(dir: string, base = dir, acc: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkExpected(p, base, acc);
    else acc[relative(base, p)] = readFileSync(p, "utf8");
  }
  return acc;
}

describe("agent-context-conformance corpus", () => {
  const cases = existsSync(CORPUS)
    ? readdirSync(CORPUS).filter((n) => existsSync(join(CORPUS, n, "stack.json")))
    : [];
  expect(cases.length).toBeGreaterThan(0);

  for (const name of cases) {
    test(name, () => {
      const dir = join(CORPUS, name);
      const spec = JSON.parse(readFileSync(join(dir, "stack.json"), "utf8")) as StackSpec;
      const stack = makeStack(spec.servers, spec.clients);
      const files = assemble({ contentRoot: CONTENT_ROOT, stack });

      const actual: Record<string, string> = {};
      for (const f of files) actual[f.path] = f.contents;

      const expected = walkExpected(join(dir, "expected"));
      // exact file set
      expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
      // byte-exact contents
      for (const path of Object.keys(expected)) expect(actual[path]).toBe(expected[path]);
      // determinism
      expect(assemble({ contentRoot: CONTENT_ROOT, stack })).toEqual(files);
    });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript/packages/sdk && bun test test/agent-context-conformance.test.ts`
Expected: FAIL — `expect(cases.length).toBeGreaterThan(0)` (no fixtures yet).

- [ ] **Step 3: Create the stack specs**

`fixtures/agent-context-conformance/ts-react-tanstack/stack.json`:

```json
{ "servers": ["typescript"], "clients": ["react", "tanstack"] }
```

`fixtures/agent-context-conformance/java-react/stack.json`:

```json
{ "servers": ["java"], "clients": ["react"] }
```

- [ ] **Step 4: Generate the golden `expected/` trees from the current assembler output**

Run this one-off generator from repo root (it writes the goldens the runner will then pin):

```bash
cd server/typescript/packages/sdk && bun -e '
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { assemble } from "./src/agent-context/assemble.js";
import { makeStack } from "./src/agent-context/resolve.js";
// Run from the sdk package dir (cwd); repo root is 4 levels up.
const CONTENT = join(process.cwd(), "../../../../agent-context");
const CORPUS = join(process.cwd(), "../../../../fixtures/agent-context-conformance");
for (const [name, servers, clients] of [["ts-react-tanstack",["typescript"],["react","tanstack"]],["java-react",["java"],["react"]]]) {
  const exp = join(CORPUS, name, "expected");
  rmSync(exp, { recursive: true, force: true });
  for (const f of assemble({ contentRoot: CONTENT, stack: makeStack(servers, clients) })) {
    const dest = join(exp, f.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.contents);
  }
  console.log("wrote", name);
}
'
```

Expected: prints `wrote ts-react-tanstack` and `wrote java-react`. Inspect the trees (`find ../../../../fixtures/agent-context-conformance -type f | sort`) and sanity-check that `ts-react-tanstack` has the `typescript`/`react`/`tanstack` references but **not** `java`, and `java-react` has `java`/`react` but **not** `typescript`/`tanstack`.

- [ ] **Step 5: Run the runner to verify it passes**

Run: `cd server/typescript/packages/sdk && bun test test/agent-context-conformance.test.ts`
Expected: PASS (2 cases).

- [ ] **Step 6: Commit**

```bash
git add fixtures/agent-context-conformance/ \
        server/typescript/packages/sdk/test/agent-context-conformance.test.ts
git commit -m "test(agent-context): conformance corpus + runner (2 stacks, byte-exact + selection)"
```

---

### Task 10: Always-on size gate

**Files:**
- Test: `server/typescript/packages/sdk/test/agent-context/size-gate.test.ts`

- [ ] **Step 1: Write the test**

```ts
// test/agent-context/size-gate.test.ts
import { test, expect } from "bun:test";
import { join } from "node:path";
import { assemble } from "../../src/agent-context/assemble.js";
import { makeStack } from "../../src/agent-context/resolve.js";

const CONTENT_ROOT = join(import.meta.dir, "../../../../../../agent-context"); // test/agent-context/ → repo root is 6 levels up

test("the always-on body stays <= 120 lines (cheap to import into a root CLAUDE.md)", () => {
  const files = assemble({ contentRoot: CONTENT_ROOT, stack: makeStack(["typescript"], ["react", "tanstack"]) });
  const agents = files.find((f) => f.path === ".metaobjects/AGENTS.md")!;
  const lines = agents.contents.split("\n").length;
  expect(lines).toBeLessThanOrEqual(120);
});
```

- [ ] **Step 2: Run the test**

Run: `cd server/typescript/packages/sdk && bun test test/agent-context/size-gate.test.ts`
Expected: PASS. If it FAILS, trim `agent-context/templates/always-on.md.mustache` (Task 4) — the always-on is a slim digest, not a manual.

- [ ] **Step 3: Commit**

```bash
git add server/typescript/packages/sdk/test/agent-context/size-gate.test.ts
git commit -m "test(agent-context): always-on size gate (<= 120 lines)"
```

---

### Task 11: Full green + public surface + handoff note

**Files:**
- Modify: `server/typescript/packages/sdk/src/agent-context/index.ts` (verify exports)
- Modify: `server/typescript/packages/sdk/README.md` (one paragraph)

- [ ] **Step 1: Confirm the public surface**

Verify `src/agent-context/index.ts` re-exports `types`, `resolve`, `assemble`, and that `src/index.ts` re-exports `./agent-context/index.js`. Add a `./agent-context` export entry to `package.json` `exports` mirroring the existing `./agent-docs` entry:

```json
"./agent-context": {
  "bun": "./src/agent-context/index.ts",
  "types": "./dist/agent-context/index.d.ts",
  "default": "./dist/agent-context/index.js"
}
```

- [ ] **Step 2: Document the package surface**

Append to `server/typescript/packages/sdk/README.md`:

```markdown
## agent-context

`@metaobjectsdev/sdk/agent-context` assembles the downstream AI-assistant context
(the slim `.metaobjects/AGENTS.md`/`CLAUDE.md` + the five `metaobjects-*` Claude
skills with only the project's language reference fragments) from the repo-root
`agent-context/` source tree. `resolveStack`/`makeStack`/`detectStack` resolve the
project's server+client axes; `assemble({ contentRoot, stack })` emits the files.
Design: `docs/superpowers/specs/2026-06-02-downstream-agent-context-design.md`.
```

- [ ] **Step 3: Run the whole package suite + typecheck**

Run: `cd server/typescript/packages/sdk && bun test && bun run typecheck`
Expected: all agent-context tests PASS; typecheck exits 0.

- [ ] **Step 4: Run the build to confirm the package compiles**

Run: `cd server/typescript/packages/sdk && bun run build`
Expected: exits 0 (the `dist/agent-context/` output exists).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/sdk/src/agent-context/index.ts \
        server/typescript/packages/sdk/package.json \
        server/typescript/packages/sdk/README.md
git commit -m "feat(agent-context): export ./agent-context subpath + document the surface"
```

---

## What this plan does NOT do (the next plans)

- **Content depth (next plan):** author the `core/` consolidated concept reference; the remaining server references (`kotlin`/`csharp`/`python`) and the `angular` client reference; deepen the seed fragments to full ≤500-line skills. Each new fragment is gated by the existing drift test + a new conformance stack.
- **P1 — TS pilot:** wire `meta init` (`@metaobjectsdev/cli`) to resolve the stack, call `assemble`, write the files content-hash-tracked (reuse `agent-docs/content-hash.ts`), offer opt-in root-CLAUDE.md wiring, support `--no-skills` / `--server` / `--client`, and **replace** the stale `agent-docs/body.ts` blob.
- **P2:** per-port emit commands (Java/Kotlin `meta:agent-docs`, Python, C#) consuming the same assembled content; add per-port conformance stacks.
- **P3:** `llms.txt` / `llms-full.txt` templates + the `metaobjects.dev` consumption.
