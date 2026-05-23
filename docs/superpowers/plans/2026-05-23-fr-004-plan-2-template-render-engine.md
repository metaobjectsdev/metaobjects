# FR-004 Plan #2 — `template.*` metatype generalization + `@metaobjectsdev/render` engine (TS)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (or subagent-driven-development). Steps use checkbox (`- [ ]`). TDD throughout. Execute in an **isolated worktree** (superpowers:using-git-worktrees) off `main`. Authoritative design: the *Design revision — 2026-05-23* section of `docs/superpowers/specs/2026-05-22-fr-004-cross-language-prompt-construction-design.md` (R1–R10).

**Goal:** Generalize the (local-only) `prompt.*` metatype to `template.{prompt,output}` + `@format`, then ship a logic-less, deterministic, LLM-agnostic render engine (`@metaobjectsdev/render`) with a render-conformance corpus and three showcase examples (complex prompt / HTML email / SpreadsheetML export).

**Architecture:** Two phases. **A** revises Plan #1's metatype (rename, format-as-attribute, drop fragment). **B** builds a new leaf package: `render(template, payload, provider) → string` over `mustache.js`, with a 2-layer `Provider`, a format-keyed escaper registry (engine-owned, identical across ports), partial resolution + cycle guard, and the determinism contract (R6). `verify` and `origin.collection` are **out of scope** → Plan #3 (the engine renders JSON-fixture payloads; it never loads projections).

**Tech Stack:** TypeScript (ESM, `type: module`), Bun test runner, `mustache` + `@types/mustache`. Run from `server/typescript`.

**Scope boundary:** no `verify`, no `origin.collection`, no assembler, no codegen, no Java. Render reads fixture payloads; payload-shape declaration + drift-check are Plan #3.

---

## Task 1: Loader refactor — `prompt.*` → `template.{prompt,output}` + `@format`

Revises Plan #1's committed metatype (`server/typescript/packages/metadata/src/prompt/`). **Files:**
- Rename dir: `src/prompt/` → `src/template/` (`meta-prompt.ts`→`meta-template.ts`, `prompt-constants.ts`→`template-constants.ts`, `prompt-schema.ts`→`template-schema.ts`)
- Modify: `src/shared/base-types.ts`, `src/core-types.ts`, `src/index.ts`
- Test: rename `test/prompt.test.ts`→`test/template.test.ts`; update `test/index.test.ts`, `test/registry.test.ts`
- Fixtures: rename `fixtures/conformance/prompt-*` → `template-*`; update `server/csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json`

- [ ] **Step 1: Update the failing test first** (`test/template.test.ts`). Assert: `TYPE_TEMPLATE === "template"`; loads `template.prompt` (with `@payloadRef`,`@textRef`,`@format: "xml"`,`@maxTokens`) and `template.output` (with `@payloadRef`,`@textRef`,`@format: "html"`) with no errors; `template.prompt` missing required `@payloadRef` → error; `template.prompt` with an out-of-enum `@format` → error (allowedValues); `@maxTokens` on `template.output` is rejected/ignored (overlay attr is prompt-only). Mirror Plan #1's `load()` helper.

```ts
import { TYPE_TEMPLATE } from "../src/shared/base-types.js";
import { TEMPLATE_SUBTYPE_PROMPT, TEMPLATE_SUBTYPE_OUTPUT } from "../src/template/template-constants.js";
// ... load() helper as in Plan #1
test("loads template.prompt + template.output", async () => {
  const { errors } = await load([
    { "template.output": { name: "digest", "@payloadRef": "AuthorBrief", "@textRef": "email/digest", "@format": "html" } },
    { "template.prompt": { name: "strategy", "@payloadRef": "AuthorBrief", "@textRef": "prompt/strategy", "@format": "xml", "@maxTokens": 4000 } },
  ]);
  expect(errors).toEqual([]);
});
test("@format outside allowedValues → error", async () => {
  const { errors } = await load([{ "template.output": { name: "x", "@payloadRef": "P", "@textRef": "r", "@format": "potato" } }]);
  expect(errors.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run → red.** `cd server/typescript/packages/metadata && bun test test/template.test.ts` → fails (TYPE_TEMPLATE missing).

- [ ] **Step 3: `base-types.ts`** — rename `TYPE_PROMPT="prompt"` → `TYPE_TEMPLATE="template"`; update the `BASE_TYPES` array entry + the count comment (still 12 base types).

- [ ] **Step 4: `src/template/template-constants.ts`** — subtypes + attrs:

```ts
import { SUBTYPE_BASE } from "../shared/base-types.js";
export const TEMPLATE_SUBTYPE_PROMPT = "prompt";
export const TEMPLATE_SUBTYPE_OUTPUT = "output";
export const TEMPLATE_SUBTYPES = [SUBTYPE_BASE, TEMPLATE_SUBTYPE_PROMPT, TEMPLATE_SUBTYPE_OUTPUT] as const;
export type TemplateSubType = (typeof TEMPLATE_SUBTYPES)[number];

// generic attrs (both subtypes)
export const TEMPLATE_ATTR_PAYLOAD_REF = "payloadRef";
export const TEMPLATE_ATTR_TEXT_REF = "textRef";
export const TEMPLATE_ATTR_FORMAT = "format";
export const TEMPLATE_ATTR_MAX_CHARS = "maxChars";
export const TEMPLATE_ATTR_OWNER = "owner";
export const TEMPLATE_ATTR_SINCE = "since";
// prompt-overlay attrs (template.prompt only)
export const TEMPLATE_ATTR_MAX_TOKENS = "maxTokens";
export const TEMPLATE_ATTR_REQUIRED_SLOTS = "requiredSlots";
export const TEMPLATE_ATTR_MODEL = "model";

// closed format set (R1/R7) — escaping is keyed off this in the render engine
export const TEMPLATE_FORMATS = ["text","html","xml","csv","json","markdown","spreadsheet"] as const;
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number];
```

- [ ] **Step 5: `src/template/meta-template.ts`** — single class backs both subtypes (as Plan #1 did for source): `export class MetaTemplate extends MetaData {}`.

- [ ] **Step 6: `src/template/template-schema.ts`** — `TEMPLATE_ATTRS_MAP` keyed by subtype. Both subtypes get the generic attrs; `@format` carries `allowedValues: [...TEMPLATE_FORMATS]`; `template.prompt` additionally gets `@maxTokens`(int)/`@requiredSlots`(stringarray)/`@model`(string). `@payloadRef`+`@textRef` `required: true`.

- [ ] **Step 7: `core-types.ts`** — rename imports/`TYPE_PROMPT`→`TYPE_TEMPLATE`; `MetaPrompt`→`MetaTemplate`; `PROMPT_*`→`TEMPLATE_*`; the root child-rule wildcard `TYPE_PROMPT`→`TYPE_TEMPLATE`; the registration loop over `TEMPLATE_SUBTYPES`. (Subtype count unchanged: base/prompt/output = 3.)

- [ ] **Step 8: `index.ts`** — `export * from "./template/template-constants.js";` and `export { MetaTemplate } from "./template/meta-template.js";` (replacing the prompt exports).

- [ ] **Step 9: Run → green.** `bun test test/template.test.ts`.

- [ ] **Step 10: Fix the two API-surface tests.** `test/index.test.ts`: `BASE_TYPES` membership `TYPE_PROMPT`→`TYPE_TEMPLATE` (length still 12). `test/registry.test.ts`: `prompt`→`template` in subtype/child assertions (registry count stays **68**; root children swap `prompt`→`template`).

- [ ] **Step 11: Rename fixtures + C# gate.** `git mv fixtures/conformance/prompt-template-simple → template-prompt-simple` (and the other two), update their `*.json` (`prompt.template`→`template.prompt`, `@outputFormat`→`@format`); regenerate `expected.json` from actual canonical output (per `spec/conformance-tests.md`); update the three names in `conformance-expected-failures.json`.

- [ ] **Step 12: Full verify.** `cd server/typescript && bun test` (server suite green) and `cd ../csharp && dotnet test` (still green via the renamed gate entries).

- [ ] **Step 13: Commit.**
```bash
git add -A && git commit -m "refactor(metadata): generalize prompt.* → template.{prompt,output} + @format [FR-004]"
```

---

## Task 2: `@metaobjectsdev/render` engine

**Files (new package `server/typescript/packages/render/`):** `package.json`, `tsconfig.json`, `tsconfig.typecheck.json`, `src/index.ts`, `src/provider.ts`, `src/escapers.ts`, `src/render.ts`, `test/render.test.ts`, `test/escapers.test.ts`.

- [ ] **Step 1: Scaffold the package** (mirror `packages/sdk/`). `package.json` name `@metaobjectsdev/render`, `type: module`, exports `.` (bun→`src/index.ts`), `build`/`typecheck` scripts, `dependencies: { "mustache": "^4.2.0" }`, `devDependencies: { "@types/mustache": "^4.2.5", "bun-types": "latest", "typescript": "^5.6.0" }`. Copy `tsconfig.json`/`tsconfig.typecheck.json` from sdk. Then `bun install` at the worktree root.

- [ ] **Step 2: Provider — failing test first** (`test/render.test.ts`). A 2-layer provider resolves `group/source` → text.

```ts
import { render, InMemoryProvider } from "../src/index.js";
test("renders a variable", () => {
  const p = new InMemoryProvider({ "g/main": "Hi {{name}}." });
  expect(render({ ref: "g/main", payload: { name: "Ada" }, provider: p, format: "text" })).toBe("Hi Ada.");
});
```

- [ ] **Step 3: `src/provider.ts`.**
```ts
export interface Provider { resolve(ref: string): string | undefined; }
export class InMemoryProvider implements Provider {
  constructor(private readonly map: Record<string, string>) {}
  resolve(ref: string) { return this.map[ref]; }
}
// FilesystemProvider: ref "group/source" → <root>/<group>/<source> (resolved during T3 if needed)
```

- [ ] **Step 4: `src/escapers.ts`** (R7/R8) — format-keyed registry, engine-owned.
```ts
import type { TemplateFormat } from "@metaobjectsdev/metadata";
const xml = (s: string) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
const injectionGuard = (s: string) => /^[=+\-@\t\r]/.test(s) ? "'" + s : s;          // R8 OWASP
const csv = (s: string) => { const v = injectionGuard(s); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v; };
const json = (s: string) => JSON.stringify(s).slice(1,-1);
const raw = (s: string) => s;
export const ESCAPERS: Record<TemplateFormat,(s:string)=>string> = {
  text: raw, markdown: raw, html: xml, xml: xml, json,
  csv, spreadsheet: (s)=>xml(injectionGuard(s)),
};
```

- [ ] **Step 5: `src/render.ts`** — wire mustache.js with the format escaper + provider-backed partials + cycle guard (R5/R6).
```ts
import Mustache from "mustache";
import type { Provider } from "./provider.js";
import { ESCAPERS } from "./escapers.js";
import type { TemplateFormat } from "@metaobjectsdev/metadata";
const MAX_DEPTH = 16;
export function render(o: { ref?: string; template?: string; payload: unknown; provider: Provider; format: TemplateFormat }): string {
  const body = o.template ?? o.provider.resolve(o.ref!);
  if (body === undefined) throw new Error(`unresolved ref: ${o.ref}`);
  // provider-backed partials with cycle guard
  const stack: string[] = [];
  const partials = new Proxy({}, { get: (_t, name: string) => {
    if (stack.includes(name)) throw new Error(`partial cycle: ${[...stack,name].join(" -> ")}`);
    if (stack.length >= MAX_DEPTH) throw new Error(`partial depth > ${MAX_DEPTH}`);
    const t = o.provider.resolve(name); return t === undefined ? "" : t;
  }});
  const prev = Mustache.escape;                  // format-driven escaping (engine-owned, R7)
  Mustache.escape = ESCAPERS[o.format];
  try { return Mustache.render(body, o.payload, partials as Record<string,string>); }
  finally { Mustache.escape = prev; }
}
```
*(Note: cycle/depth tracking around recursive partials is refined during impl; the contract is "depth bound + cycle error.")*

- [ ] **Step 6: TDD the contract** in `test/render.test.ts` + `test/escapers.test.ts`: variable + array iteration (`{{#xs}}`); inverted section (`{{^xs}}`); partial via provider (`{{> g/frag }}`); **cycle → throws**; per-format escaping (html escapes `<`, text raw, csv quotes commas); **formula-injection** (`=cmd` → `'=cmd`); raw `{{{x}}}` bypasses escape; unresolved ref throws. Run → green; `bun run typecheck`.

- [ ] **Step 7: Commit.** `git add packages/render && git commit -m "feat(render): @metaobjectsdev/render — logic-less Mustache engine + 2-layer provider + format escapers [FR-004]"`

---

## Task 3: Render-conformance corpus + 3 examples

**Files:** `fixtures/render-conformance/<name>/{ meta.json, template.mustache, partials/*.mustache, payload.json, expected.txt }`; runner `packages/render/test/render-conformance.test.ts`.

- [ ] **Step 1: Define the corpus format + runner.** `meta.json` = `{ "format": "<TemplateFormat>", "entry": "main" }`; partials in `partials/` keyed by filename (ref `partials/<name>`); the runner loads each fixture dir, builds an `InMemoryProvider` from `template.mustache` + `partials/*`, renders `entry` against `payload.json`, and asserts **byte-equal** to `expected.txt` (trailing newline pinned). Mirror the loader conformance runner's auto-discovery.

- [ ] **Step 2: Targeted determinism/escaping fixtures** (small, one concern each): `render-escape-html`, `render-escape-csv-injection`, `render-array-iteration`, `render-inverted-section`, `render-partial-include`, `render-whitespace-standalone`. Author `expected.txt` from actual engine output, then assert it's stable across two runs.

- [ ] **Step 3: Example 1 — complex prompt** (`render-example-prompt`, format `xml`): payload = a nested `AuthorBrief` JSON (displayName, postCount, `posts[]` each with `title`/`publishedAt`/`tags[]`) shaped from the `trainerWebsite` entities; template iterates posts + tags, includes a `partials/tone` fragment; `expected.txt` = the rendered XML prompt.

- [ ] **Step 4: Example 2 — HTML email** (`render-example-email`, format `html`): same `AuthorBrief` payload; an HTML digest with a `{{#posts}}` list; verifies HTML-escaping of a title containing `<`/`&`.

- [ ] **Step 5: Example 3 — SpreadsheetML export** (`render-example-spreadsheet`, format `spreadsheet`): payload = `SiteWorkbook` JSON (`summary` + `users[]`/`posts[]`/`tags[]`); template emits SpreadsheetML XML — a summary worksheet (entity/field data-dictionary) + one worksheet per array; verifies XML-escaping + **formula-injection neutralization** on a cell value starting with `=`.

- [ ] **Step 6: Run + commit.** `cd server/typescript/packages/render && bun test` (all conformance + examples green). `git add fixtures/render-conformance packages/render/test && git commit -m "test(render): render-conformance corpus + prompt/email/spreadsheet examples [FR-004]"`

---

## Self-review

- **Spec coverage:** R1 (template.{prompt,output}+@format) → T1; R2 (drop fragment) → T1; R5 (engine/Mustache) → T2; R6 (determinism) → T2 Step6 + T3 Step2; R7 (escaping) → T2 Step4; R8 (injection) → T2 Step4 + T3; the 3 examples → T3. Deferred per design: R3 addressing is 2-layer (provider refs already `group/source`); R4 `origin.collection` + R-verify → **Plan #3**; R9/R10 unaffected.
- **No placeholders:** code shown for every non-trivial step; the one soft spot (mustache.js per-render escape via save/restore of `Mustache.escape`, and the partial-cycle Proxy) is flagged as refine-during-impl with a pinned contract.
- **Type consistency:** `TemplateFormat`/`TEMPLATE_FORMATS` defined in metadata constants (T1 Step4), consumed by the escaper registry (T2 Step4) — single source of truth.
- **No-break:** T1 Step12 re-runs the full server suite + C# `dotnet test`; the render package is additive.
