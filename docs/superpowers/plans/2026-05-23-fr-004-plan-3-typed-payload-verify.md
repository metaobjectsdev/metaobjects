# FR-004 Plan #3 — typed payload VO + typed render handle + `verify` (the drift guarantee)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. TDD throughout. Execute in an isolated worktree off the **latest** `main`. Authoritative design: the *Design revision — 2026-05-23* section of the FR-004 spec (R1–R10) + the verify discussion captured below.

**Goal:** Turn the render slice from "Mustache works" into the actual pillar value — *typed, drift-checked prompts* — proven by a single demo that **fails to compile** on a wrong-shaped payload **and fails `verify`** on a template that references a field the payload doesn't have.

**The load-bearing fact this plan is built on:** a Mustache template is an opaque runtime **string** — the TS compiler cannot see into `{{npcName}}`. So passing a typed VO into Mustache buys nothing by itself. Enforcement comes from **two** distinct mechanisms, neither of which is "VO into Mustache":
1. **Caller side (compile-time):** a payload VO **type** codegen'd *from the projection metadata* + a typed render handle, so the call site can't pass a payload that doesn't match the declared shape.
2. **Template side (build-time):** `verify` — parse the template's tokens and cross-check them against the VO's metadata-declared fields. This is the only way to check the template, *because* Mustache is a string.

Together they close the loop. Plain JSON → raw Mustache (Plan #2) demonstrates neither; Plan #2 was the engine substrate. **This plan is the value.**

**Verify runs at the last fixed point before serve, never on the request path:** load-time for metadata-internal checks (Phase A), build-time `meta verify` for the template-text check (Phase C), and an optional engine `verify`-on-resolve guard (fail-closed) for dynamic providers.

**Tech Stack:** TypeScript, `@metaobjectsdev/codegen-ts` (VO + handle generators), `mustache` (`Mustache.parse` for token extraction), `@metaobjectsdev/cli` (`meta verify`).

---

## Phase A — loader: `origin.collection` + load-time validation (metadata-internal)

- [ ] **T1 · `origin.collection` subtype.** Add the nested-array origin (mirrors `origin.passthrough`/`aggregate`): `@via` (a relationship dotted-path) + optional wildcard selector for package-spanning collections. Loader recognition + schema + 1 conformance fixture + C# expected-failures gate. This lets an `object.value` view-object declare `posts: PostBrief[]` from `User.posts`.

- [ ] **T2 · Load-time validation pass** (`MetaData.validate()` / a loader validation pass — same phase as the existing `origin.passthrough @from` resolution):
  - `@payloadRef` resolves to a real `object.value` in the loaded model → else `ERR_PAYLOAD_REF_UNRESOLVED`.
  - every `@requiredSlots` entry is a real field on that view-object → else `ERR_REQUIRED_SLOT_MISSING`.
  These are pure metadata cross-references (no provider, no I/O) — they run on every load, including loud at app startup. Conformance **error** fixtures for each. (Template-text checks are NOT here — they need the provider; Phase C.)

---

## Phase B — codegen: typed payload VO + typed render handle (caller-side compile-time)

- [ ] **T3 · Payload-VO type generator** (a `codegen-ts` generator). From an `object.value` view-object emit a TS type: passthrough/aggregate fields → scalars; `origin.collection` fields → arrays of nested VO types. Example output for the `AuthorBrief` projection over `trainerWebsite`:

```ts
// generated
export interface AuthorBrief {
  displayName: string;
  postCount: number;
  posts: AuthorBriefPost[];
}
export interface AuthorBriefPost {
  title: string;
  tags: { name: string }[];
}
```

- [ ] **T4 · Typed render-handle generator.** Per `template.*` node, emit a handle that binds the template's `@textRef` + `@format` and types its payload to the `@payloadRef` VO:

```ts
// generated
import { render, type Provider } from "@metaobjectsdev/render";
import type { AuthorBrief } from "./payloads.js";
export function renderContentStrategyPrompt(payload: AuthorBrief, provider: Provider): string {
  return render({ ref: "prompt/content-strategy", payload, provider, format: "xml" });
}
```
The generated artifact has **zero MetaObjects runtime dep beyond `@metaobjectsdev/render`** (per the framework philosophy). The caller now gets a compile error if it passes the wrong payload shape.

---

## Phase C — `verify` (template-side, build-time) + the demo

- [ ] **T5 · `verify(templateText, voFields)` (in `@metaobjectsdev/render`).** Use `Mustache.parse(template)` to walk tokens; collect interpolations (`name`/`&`/`{`), sections (`#`/`^`), and partials (`>`). Check each variable path against the VO field tree **context-sensitively** — a `{{#posts}}{{title}}{{/posts}}` checks `title` against `posts`' element type. Return a list of `{ code, path }` drift errors:
  - `{{var}}` not a field on the (contextual) VO → `ERR_VAR_NOT_ON_PAYLOAD`.
  - `@requiredSlots` slot never referenced → `ERR_REQUIRED_SLOT_UNUSED` (warning).
  - `{{> ref}}` unresolved in the provider → `ERR_PARTIAL_UNRESOLVED`.
  TDD: a matrix of templates × VO field-trees → expected error lists.

- [ ] **T6 · `meta verify` CLI command** (`@metaobjectsdev/cli`). Load metadata + a filesystem provider; for each `template.*` node resolve its text via the provider, derive its `@payloadRef` VO field tree from the loaded metadata, run `verify`, and exit non-zero on any drift (the CI gate). Also wire the **engine `verify`-on-resolve mode** (`render({ verify: voFields })`) as the fail-closed guard for dynamic providers (reject/throw a drifted variant before render).

- [ ] **T7 · THE DEMO — proves both failures.** This is the acceptance criterion for the whole pillar.
  - **(a) compile-time:** a TS test importing the generated handle:
    ```ts
    import { renderContentStrategyPrompt } from "./generated/handles.js";
    import type { AuthorBrief } from "./generated/payloads.js";
    const good: AuthorBrief = { displayName: "Ada", postCount: 1, posts: [] };
    renderContentStrategyPrompt(good, provider);            // ✓ type-checks
    // @ts-expect-error — wrong payload shape is a compile error
    renderContentStrategyPrompt({ nope: 1 }, provider);
    ```
    The build passes **only if** the `@ts-expect-error` line genuinely errors → compile-time enforcement demonstrated.
  - **(b) build-time:** a fixture where the template references a non-field:
    ```ts
    const drift = verify("Hi {{displayName}}, you have {{notARealField}}.", authorBriefFields);
    expect(drift.map(e => e.code)).toContain("ERR_VAR_NOT_ON_PAYLOAD");
    ```
    Drift caught at build, loudly → the renamed-field-breaks-a-prompt guarantee demonstrated.

---

## Self-review

- **This delivers the value Plan #2 only set up:** caller-side compile-time (T3/T4) + template-side build-time (T5/T6), proven by the two-failure demo (T7). Without it, the slice is "a Mustache wrapper + a metadata lookup."
- **Verify timing (never runtime-on-request):** Phase A = load-time metadata-internal; Phase C = build-time `meta verify` + a fail-closed engine guard for dynamic text. Matches the "variable text vs fixed VO contract, checked at the last fixed point before serve" model.
- **Known hard spot:** context-sensitive var checking in T5 (sections change the VO context; dotted paths; `{{.}}` in a scalar array). Build the VO field-tree walker carefully; fixture it heavily.
- **Scope:** large — execute Phase A → B → C, and split into Plan #3a/#3b/#3c if a phase outgrows a session. Phase C T7 is the definition of done.
- **Out of scope (later):** the assembler (projection metadata → materialized payload at runtime, host-side/FR-003); Java port.
