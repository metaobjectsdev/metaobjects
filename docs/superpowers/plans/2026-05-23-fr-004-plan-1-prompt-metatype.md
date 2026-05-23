# FR-004 Plan #1 — `prompt.*` metatype + loader + conformance fixtures (TS reference)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement task-by-task. Steps use checkbox (`- [ ]`) syntax. TDD throughout. Execute in an **isolated worktree** (superpowers:using-git-worktrees), not the main checkout — FR-003 is in flight in a separate worktree.

**Goal:** Add the `prompt` base metatype (subtypes `template`, `fragment`) to the TypeScript reference loader, plus shared conformance fixtures, without breaking the green C# conformance suite.

**Architecture:** `prompt` is a new base type modelled exactly on the recently-added `origin` (subtype→class dispatch, attr-only children). It gets its own concern folder `src/prompt/`. The loader is data-driven from constants + a registration loop in `core-types.ts`; the canonical serializer needs no changes. Shared `prompt-*` fixtures are added to `fixtures/conformance/`; because C#/Java don't support `prompt.*` yet, the fixtures are registered in C#'s `conformance-expected-failures.json` allowlist so its suite stays green. (Java's conformance harness is not yet in `main` — it's the in-flight H3b worktree work — so no Java gating is needed here; coordinate when H3b lands.)

**Scope boundary (deferred to later plans):** payload-as-projection (Layer 1, needs FR-003 §5), the render engine + section-format grammar + filesystem/RDB providers + golden harness (Plan #2), and porting `prompt.*` to the C#/Java loaders. This plan is the metatype vocabulary + loader recognition + validation + fixtures only.

**Tech Stack:** TypeScript (ESM), Bun test runner. Run tests from `server/typescript/packages/metadata/`.

**Reference files (read before starting):**
- Base types: `server/typescript/packages/metadata/src/shared/base-types.ts` (`SUBTYPE_BASE`, `BASE_TYPES`)
- Mirror pattern (origin): `src/persistence/origin/{origin-constants.ts,meta-origin.ts,origin-schema.ts}`
- Registration: `src/core-types.ts` (`def()` @105, `wildcard()` @97, origin block @262-271)
- Attr schema type: `src/registry.ts` (`AttrSchema` @32); attr value-type constants: `src/core/attr/attr-constants.ts`
- Node base: `src/shared/meta-data.ts` (`ownAttr(name)` @231)
- Exports: `src/index.ts`
- Conformance: `fixtures/conformance/` (mirror `origin-passthrough-simple/`, `error-origin-bad-aggregate-fn/`), runner `server/typescript/packages/metadata/test/conformance.test.ts`, spec `spec/conformance-tests.md`
- C# gate: `server/csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json`

---

## Task 1: `prompt.*` recognized, validated, and accessor-backed in the TS loader

**Files:**
- Create: `server/typescript/packages/metadata/src/prompt/prompt-constants.ts`
- Create: `server/typescript/packages/metadata/src/prompt/meta-prompt.ts`
- Create: `server/typescript/packages/metadata/src/prompt/prompt-schema.ts`
- Modify: `server/typescript/packages/metadata/src/shared/base-types.ts`
- Modify: `server/typescript/packages/metadata/src/core-types.ts`
- Modify: `server/typescript/packages/metadata/src/index.ts`
- Test: `server/typescript/packages/metadata/test/prompt.test.ts`

- [ ] **Step 1: Write the failing test.** Create `test/prompt.test.ts`. (Mirror an existing loader test for `loadFromString`/`loadFromDirectory` usage — check `test/` for the exact loader entrypoint and adapt; the assertions below are the contract.)

```ts
import { describe, it, expect } from "bun:test";
import { Loader } from "../src/index.js"; // adjust to the test helper other tests use
import { TYPE_PROMPT } from "../src/shared/base-types.js";
import { PROMPT_SUBTYPE_TEMPLATE, PROMPT_SUBTYPE_FRAGMENT } from "../src/prompt/prompt-constants.js";

const good = {
  "metadata.root": {
    package: "acme::ai",
    children: [
      { "object.entity": { name: "Npc", children: [
        { "field.string": { name: "name" } },
        { "identity.primary": { "@fields": "name" } },
      ] } },
      { "prompt.fragment": { name: "combatRules", "@textRef": "rules/combat#core" } },
      { "prompt.template": { name: "npcTurn",
        "@payloadRef": "NpcPromptPayload", "@textRef": "npc/turn#main",
        "@outputFormat": "xml" } },
    ],
  },
};

describe("prompt metatype", () => {
  it("registers prompt as a base type", () => {
    expect(TYPE_PROMPT).toBe("prompt");
  });

  it("loads prompt.template and prompt.fragment with no errors", () => {
    const res = Loader().loadFromString(JSON.stringify(good)); // adapt to actual API
    expect(res.errors).toEqual([]);
    const tmpl = res.root.find(PROMPT_SUBTYPE_TEMPLATE, "npcTurn"); // adapt finder to actual API
    expect(tmpl?.payloadRef).toBe("NpcPromptPayload");
    expect(tmpl?.textRef).toBe("npc/turn#main");
    expect(tmpl?.outputFormat).toBe("xml");
    const frag = res.root.find(PROMPT_SUBTYPE_FRAGMENT, "combatRules");
    expect(frag?.textRef).toBe("rules/combat#core");
  });

  it("errors when prompt.template omits required @payloadRef", () => {
    const bad = structuredClone(good);
    delete (bad["metadata.root"].children[2] as any)["prompt.template"]["@payloadRef"];
    const res = Loader().loadFromString(JSON.stringify(bad));
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it; confirm it fails.** Run: `cd server/typescript/packages/metadata && bun test test/prompt.test.ts`. Expected: FAIL — `TYPE_PROMPT` is not exported / loader reports unknown type `prompt.template`.

- [ ] **Step 3: Add the base type.** In `src/shared/base-types.ts`, add `export const TYPE_PROMPT = "prompt";` next to `TYPE_ORIGIN`, and append `TYPE_PROMPT` to the `BASE_TYPES` array.

- [ ] **Step 4: Create `src/prompt/prompt-constants.ts`.**

```ts
import { SUBTYPE_BASE } from "../shared/base-types.js";

export const PROMPT_SUBTYPE_TEMPLATE = "template";
export const PROMPT_SUBTYPE_FRAGMENT = "fragment";

export const PROMPT_SUBTYPES = [
  SUBTYPE_BASE,
  PROMPT_SUBTYPE_TEMPLATE,
  PROMPT_SUBTYPE_FRAGMENT,
] as const;
export type PromptSubType = (typeof PROMPT_SUBTYPES)[number];

// Reserved @-attr names (no '@' in the constant; prefix is applied at wire time).
export const PROMPT_ATTR_PAYLOAD_REF = "payloadRef";
export const PROMPT_ATTR_TEXT_REF = "textRef";
export const PROMPT_ATTR_OUTPUT_FORMAT = "outputFormat";
export const PROMPT_ATTR_REQUIRED_SLOTS = "requiredSlots";
export const PROMPT_ATTR_MAX_CHARS = "maxChars";
export const PROMPT_ATTR_MAX_TOKENS = "maxTokens";
export const PROMPT_ATTR_OWNER = "owner";
export const PROMPT_ATTR_SINCE = "since";
```

- [ ] **Step 5: Create `src/prompt/meta-prompt.ts`** (mirror `meta-origin.ts` — base + subtype classes, accessors via `ownAttr`).

```ts
import { MetaData } from "../shared/meta-data.js";
import {
  PROMPT_ATTR_PAYLOAD_REF, PROMPT_ATTR_TEXT_REF, PROMPT_ATTR_OUTPUT_FORMAT,
  PROMPT_ATTR_REQUIRED_SLOTS, PROMPT_ATTR_MAX_CHARS, PROMPT_ATTR_MAX_TOKENS,
} from "./prompt-constants.js";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export class MetaPrompt extends MetaData {
  get textRef(): string | undefined { return str(this.ownAttr(PROMPT_ATTR_TEXT_REF)); }
}

export class MetaPromptTemplate extends MetaPrompt {
  get payloadRef(): string | undefined { return str(this.ownAttr(PROMPT_ATTR_PAYLOAD_REF)); }
  get outputFormat(): string | undefined { return str(this.ownAttr(PROMPT_ATTR_OUTPUT_FORMAT)); }
  get requiredSlots(): unknown { return this.ownAttr(PROMPT_ATTR_REQUIRED_SLOTS); }
  get maxChars(): number | undefined { return num(this.ownAttr(PROMPT_ATTR_MAX_CHARS)); }
  get maxTokens(): number | undefined { return num(this.ownAttr(PROMPT_ATTR_MAX_TOKENS)); }
}

export class MetaPromptFragment extends MetaPrompt {}
```

- [ ] **Step 6: Create `src/prompt/prompt-schema.ts`** (mirror `origin-schema.ts`; `required: true` is what drives the missing-attr error). Confirm value-type constant names in `src/core/attr/attr-constants.ts` (use the string one and the int one; if a string-array subtype exists, use it for `requiredSlots`, else `ATTR_SUBTYPE_STRING`).

```ts
import type { AttrSchema } from "../registry.js";
import { ATTR_SUBTYPE_STRING, ATTR_SUBTYPE_INT } from "../core/attr/attr-constants.js";
import { SUBTYPE_BASE } from "../shared/base-types.js";
import {
  PROMPT_SUBTYPE_TEMPLATE, PROMPT_SUBTYPE_FRAGMENT,
  PROMPT_ATTR_PAYLOAD_REF, PROMPT_ATTR_TEXT_REF, PROMPT_ATTR_OUTPUT_FORMAT,
  PROMPT_ATTR_REQUIRED_SLOTS, PROMPT_ATTR_MAX_CHARS, PROMPT_ATTR_MAX_TOKENS,
  PROMPT_ATTR_OWNER, PROMPT_ATTR_SINCE,
} from "./prompt-constants.js";

const templateAttrs: AttrSchema[] = [
  { name: PROMPT_ATTR_PAYLOAD_REF, valueType: ATTR_SUBTYPE_STRING, required: true,
    description: "The object.value projection this template renders against." },
  { name: PROMPT_ATTR_TEXT_REF, valueType: ATTR_SUBTYPE_STRING, required: true,
    description: "Logical reference to the template body text." },
  { name: PROMPT_ATTR_OUTPUT_FORMAT, valueType: ATTR_SUBTYPE_STRING, required: false,
    description: "Expected output format, e.g. xml | json | text." },
  { name: PROMPT_ATTR_REQUIRED_SLOTS, valueType: ATTR_SUBTYPE_STRING, required: false,
    description: "Slots that must resolve at render time (drives verify)." },
  { name: PROMPT_ATTR_MAX_CHARS, valueType: ATTR_SUBTYPE_INT, required: false,
    description: "Size budget in characters." },
  { name: PROMPT_ATTR_MAX_TOKENS, valueType: ATTR_SUBTYPE_INT, required: false,
    description: "Size budget in tokens." },
  { name: PROMPT_ATTR_OWNER, valueType: ATTR_SUBTYPE_STRING, required: false, description: "Governance: owner." },
  { name: PROMPT_ATTR_SINCE, valueType: ATTR_SUBTYPE_STRING, required: false, description: "Governance: since version." },
];

const fragmentAttrs: AttrSchema[] = [
  { name: PROMPT_ATTR_TEXT_REF, valueType: ATTR_SUBTYPE_STRING, required: true,
    description: "Logical reference to the fragment body text." },
  { name: PROMPT_ATTR_OWNER, valueType: ATTR_SUBTYPE_STRING, required: false, description: "Governance: owner." },
  { name: PROMPT_ATTR_SINCE, valueType: ATTR_SUBTYPE_STRING, required: false, description: "Governance: since version." },
];

export const PROMPT_ATTRS_MAP = new Map<string, AttrSchema[]>([
  [SUBTYPE_BASE, []],
  [PROMPT_SUBTYPE_TEMPLATE, [...templateAttrs]],
  [PROMPT_SUBTYPE_FRAGMENT, [...fragmentAttrs]],
]);
```

- [ ] **Step 7: Wire registration in `src/core-types.ts`** (mirror the origin block @262-271).
  - Add to base-type imports: `TYPE_PROMPT`.
  - Add imports: `import { MetaPrompt, MetaPromptTemplate, MetaPromptFragment } from "./prompt/meta-prompt.js";`, `import { PROMPT_SUBTYPES, PROMPT_SUBTYPE_TEMPLATE, PROMPT_SUBTYPE_FRAGMENT } from "./prompt/prompt-constants.js";`, `import { PROMPT_ATTRS_MAP } from "./prompt/prompt-schema.js";`
  - Near the `ORIGIN_CLASS_MAP` definition add:
    ```ts
    const PROMPT_CLASS_MAP = new Map([
      [PROMPT_SUBTYPE_TEMPLATE, MetaPromptTemplate],
      [PROMPT_SUBTYPE_FRAGMENT, MetaPromptFragment],
    ]);
    ```
  - After the origin registration loop add:
    ```ts
    // prompt — LLM prompt construction (template, fragment). Only attr children.
    // Subtype→class dispatch: template → MetaPromptTemplate, fragment → MetaPromptFragment,
    // base (and any unmapped subtype) → MetaPrompt.
    for (const subType of PROMPT_SUBTYPES) {
      const NodeClass = PROMPT_CLASS_MAP.get(subType) ?? MetaPrompt;
      const promptAttrs = PROMPT_ATTRS_MAP.get(subType) ?? [];
      registry.register(
        def(TYPE_PROMPT, subType, `Prompt (${subType})`, [wildcard(TYPE_ATTR)], NodeClass, promptAttrs),
      );
    }
    ```

- [ ] **Step 8: Export from `src/index.ts`** (mirror origin lines): `export * from "./prompt/prompt-constants.js";` and `export { MetaPrompt, MetaPromptTemplate, MetaPromptFragment } from "./prompt/meta-prompt.js";` (plus the `import type` line if the file maintains a type-only import block like origin's).

- [ ] **Step 9: Run the test; confirm it passes.** Run: `cd server/typescript/packages/metadata && bun test test/prompt.test.ts`. Expected: PASS (all three cases). If the finder/loader API names in Step 1 don't match the real API, fix the test to use the real entrypoints (do NOT weaken the assertions).

- [ ] **Step 10: Run the whole metadata package + typecheck.** Run: `cd server/typescript/packages/metadata && bun test && bunx tsc --noEmit` (or the package's typecheck script). Expected: all green — no regressions from adding the base type.

- [ ] **Step 11: Commit.**

```bash
git add server/typescript/packages/metadata/src/prompt server/typescript/packages/metadata/src/shared/base-types.ts server/typescript/packages/metadata/src/core-types.ts server/typescript/packages/metadata/src/index.ts server/typescript/packages/metadata/test/prompt.test.ts
git commit -m "feat(metadata): add prompt.* base metatype (template, fragment) [FR-004]"
```

---

## Task 2: Shared conformance fixtures + C# expected-failures gate

**Files:**
- Create: `fixtures/conformance/prompt-template-simple/{input/meta.ai.json,expected.json}`
- Create: `fixtures/conformance/prompt-fragment-and-template/{input/meta.ai.json,expected.json}`
- Create: `fixtures/conformance/error-prompt-template-missing-payload-ref/{input/meta.ai.json,expected-errors.json}`
- Modify: `server/csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json`

- [ ] **Step 1: Author the happy-path fixture inputs.** Create `prompt-template-simple/input/meta.ai.json` with a `metadata.root` (package `acme::ai`) containing an `object.entity` "Npc" (one `field.string` "name" + `identity.primary` `@fields: "name"`) and a `prompt.template` "npcTurn" with `@payloadRef`, `@textRef`, `@outputFormat: "xml"`. Create `prompt-fragment-and-template/input/meta.ai.json` adding a `prompt.fragment` "combatRules" (`@textRef`) alongside the template. (Match the JSON shape of `origin-passthrough-simple/input/`.)

- [ ] **Step 2: Generate `expected.json` from actual canonical output.** Per `spec/conformance-tests.md` §"Adding a new fixture": run the TS conformance test for each new fixture, which fails with an actual-vs-expected diff; set `expected.json` to the actual canonical output (fused-key form; `@fields` normalized to array; `@`-attrs alphabetical; 2-space indent; trailing newline).
  Run: `cd server/typescript/packages/metadata && bun test test/conformance.test.ts -t "prompt-template-simple"` then `... -t "prompt-fragment-and-template"`. Paste the actual canonical output into each `expected.json`. Re-run: both PASS.

- [ ] **Step 3: Author the error fixture.** Create `error-prompt-template-missing-payload-ref/input/meta.ai.json` (a `prompt.template` missing `@payloadRef`). For `expected-errors.json`, use the array-of-`{code}` format (confirmed from `error-origin-bad-aggregate-fn/expected-errors.json`). Determine the exact code emitted for a missing required attr by reading `src/attr-schema-validate.ts` (the required-attr check) — set `expected-errors.json` to `[{ "code": "<that code>" }]`.
  Run: `cd server/typescript/packages/metadata && bun test test/conformance.test.ts -t "error-prompt-template-missing-payload-ref"`. Expected: PASS. If the emitted code differs, set the fixture to the actual emitted code.

- [ ] **Step 4: Run the full TS conformance suite.** Run: `cd server/typescript/packages/metadata && bun test test/conformance.test.ts`. Expected: all fixtures green, including the three new `prompt-*`.

- [ ] **Step 5: Gate C# so its suite stays green.** Add the three fixture directory names to the `fixtures` array in `server/csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json`:

```json
{
  "language": "csharp",
  "fixtures": [
    "prompt-template-simple",
    "prompt-fragment-and-template",
    "error-prompt-template-missing-payload-ref"
  ]
}
```

- [ ] **Step 6: Verify C# stays green.** Run: `cd server/csharp && dotnet test 2>&1 | tail -20`. Expected: pass. The C# loader will not recognize `prompt.*`; the expected-failures allowlist absorbs those three. **If a `prompt.*` fixture throws inside C# rather than being caught as a known failure** (e.g. unknown nested type throws instead of collecting an error), stop and report — the allowlist may key on collected-error fixtures only, and the C# parser's unknown-nested-type behavior needs confirming before this gating approach is final.

- [ ] **Step 7: Commit.**

```bash
git add fixtures/conformance/prompt-template-simple fixtures/conformance/prompt-fragment-and-template fixtures/conformance/error-prompt-template-missing-payload-ref server/csharp/MetaObjects.Conformance.Tests/conformance-expected-failures.json
git commit -m "test(conformance): add prompt.* fixtures + gate C# expected-failures [FR-004]"
```

---

## Self-review notes

- **Spec coverage:** FR-004 §2 (prompt.template/fragment + reserved attrs) → Task 1. FR-004 §9 (loader/serializer conformance for prompt vocabulary) → Task 2. Deferred: §1 payload-as-projection, §3–§6 (addressing/render/variants/verify beyond required-attr), §7 codegen — Plan #2 and FR-003-dependent follow-ups, explicitly out of scope here.
- **No-break guarantee:** Task 2 Step 5–6 keep C# green; Java has no `main` harness yet (coordinate at H3b). The serializer is data-driven (no change). The canonical serializer §key-order is unaffected — `prompt.*` nodes only carry `name` + `@`-attrs + (no children beyond attrs).
- **Open risk flagged inline:** C# unknown-nested-type behavior (Task 2 Step 6) — verified at runtime, with a stop-and-report fallback rather than a guess.
- **`@requiredSlots` typing:** left as `ATTR_SUBTYPE_STRING` pending the §1/§6 design (array vs csv); accessor returns raw `unknown`. Revisit in Plan #2.
