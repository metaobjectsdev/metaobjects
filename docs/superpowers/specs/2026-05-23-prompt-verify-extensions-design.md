# Prompt-pillar verify extensions: output-tag preservation, output budget, and prompt tooling

**Status:** Design / plan-of-record. Not yet implemented.
**Depends on:** the shipped FR-004 render engine + `verify` + `fixtures/verify-conformance/` corpus (TS, C#, Python).
**Roadmap:** extends H6 (prompt construction, the fourth pillar).

## Why (motivation from real consumers)

Two real downstream consumers — a **Python AI/reasoning engine** and a **JVM (Java) narrative/game service** — are adopting the prompt pillar to tame prompt sprawl. Surveying both surfaced a consistent, currently-unguarded failure mode that should drive what we build next:

- **Tag-contract systems.** Both emit structured model output wrapped in XML-ish tags (`<answer>`, `<reasoning>`, `<result>`, `<mechanics>`, `<resolution>`, …) and parse it back with regex downstream. The prompt's *required output tags* and the parser's *expected tags* are maintained **by hand in two distant places**, with nothing tying them together. Delete or rename a tag while editing a prompt and the parser silently returns nothing — at runtime, with no build-time signal. One consumer has already hand-rolled a partial version of this guard (`required_tags` + a max-length budget) in a single corner; the other has ~30 regex tag-parsers with no guard at all.
- **Prompt sprawl, untyped or imperative.** One consumer holds ~dozens of inline prompt string-constants filled via untyped string formatting; the other assembles prompts imperatively in multi-thousand-line builder classes. Neither keeps prompt text in external files today.
- **Fragile prompt caching.** One consumer has provider prompt-caching enabled but rides a single flat prefix with no `cache_control` breakpoints and **no drift guard** — a stray whitespace change anywhere upstream silently busts the cache (slower + more expensive) without changing behavior.
- **Expensive stand-ins for static checks.** One consumer pays real LLM dollars in gated "live" tests to pin prompt contracts that a free static check could cover.

**Conclusion that reorders the backlog:** the highest-leverage addition is **output-tag preservation in `verify`** (declare the tags a prompt's text must contain; fail the build if one goes missing). It directly defends the failure mode both consumers are fighting by hand, and — because `verify` is already a cross-language conformance-gated check — it propagates to every port that has `verify`. A typed-prompt-handle generator (calling prompts as generated typed functions), by contrast, is the *weakest* fit for these two consumers (one already passes strongly-typed inputs; the other's pain is imperative string assembly, not call-site typing).

## Scope

Extend the existing cross-language `verify` + render engine with a **prompt profile**. Four features, prioritized by the survey:

| # | Feature | Value (this cohort) | Slice |
|---|---|---|---|
| **2** | `@requiredTags` (static, verify-time) + output **budget** guard (render-time) | **High** for both | **First slice (this doc's focus)** |
| **4** | Prompt snapshot harness (deterministic byte-snapshot) | High (caching consumer), Medium (other) | Follow-on |
| **3** | `verify` machine output (`--json` / `--strict`) | Derivative (CI surface for #2/#4) | Follow-on |
| **1** | Typed prompt-handle codegen (`templateFile()` generator) | Low–Medium; weakest here | Deferred |

The first slice is **#2**. The other three are sketched below for plan-of-record, deliberately deprioritized.

---

## First slice — #2: `@requiredTags` + output budget

### Durable cross-language contract

1. **New template attribute `@requiredTags: string[]`** on `template.prompt` and `template.output`. Each entry names an output tag the rendered prompt is contracted to contain. Declared in the template constants + attr schema of every port (named-constants discipline; closed string-array type).

2. **`verify` gains a static output-tag check.** After the existing variable/section/partial walk, for each `requiredTag` the template body — including resolved partials — MUST contain both an opening `<tag` and a closing `</tag>` form. A missing tag yields a new stable error code:
   - **`ERR_OUTPUT_TAG_MISSING`** — "a template declares `@requiredTags` but its text omits a required output tag." `path` = the tag name. Added to `fixtures/conformance/ERROR-CODES.json`.
   This is a *static text* check (no rendering, no payload data), so it is conformance-testable and byte-portable.

3. **Output budget is a render-time guard, not a verify-time check.** `@maxChars` already exists as a template attr. Rendered length is data-dependent (only knowable after rendering), so the budget is enforced at **render time**: `render()` gains an optional `maxChars` that throws if the rendered string exceeds it. This is a runtime guard, **not** conformance-scoped (it depends on payload data).
   - **`@maxTokens` is explicitly out of scope.** Token counting needs a model-specific tokenizer — non-deterministic across languages and not byte-conformance-testable. It belongs to runtime/eval, not verify or render-conformance.

4. **Conformance fixtures** (in `fixtures/verify-conformance/`, the shared corpus): at minimum
   - `verify-required-tags-present` — template contains all declared tags → `[]`.
   - `verify-required-tag-missing-open` — open tag absent → `[ERR_OUTPUT_TAG_MISSING]`.
   - `verify-required-tag-missing-close` — close tag absent → `[ERR_OUTPUT_TAG_MISSING]`.
   - `verify-required-tag-in-partial` — required tag supplied by a resolved partial → `[]` (proves the check sees expanded partials).
   The corpus already passes `options.json` `{ requiredSlots?, provider? }`; extend it with `requiredTags?` so the runner threads it into `verify`.

### Open contract decisions (resolve during planning)

- **Open-tag match precision.** Match `<tag` (prefix, allowing attributes like `<answer foo="1">`) + `</tag>`, vs. exact `<tag>`. Recommended: prefix match for the open tag (`<tag` followed by `>` or whitespace) to allow attributes; exact `</tag>` for the close. Pin this in fixtures.
- **Self-closing / void tags.** Decide whether `<tag/>` satisfies a required tag (recommended: no — `requiredTags` is for wrapper tags whose content is parsed; document it).
- **Where the tag text is sourced.** The check runs over the template body + provider-resolved partials (same expansion `verify` already does for partial-drift). Confirm no double-resolution.

### Per-port plan (reference-first; do NOT big-bang)

Implement against the **conformance corpus as the executable spec**, in this order:

1. **TS (reference)** — extend `verify.ts` + template constants/schema + the render `maxChars` guard; add the `verify-conformance` fixtures; add `ERR_OUTPUT_TAG_MISSING` to `ERROR-CODES.json`. The fixtures *define* expected behavior.
2. **C#** — extend `Verify.cs` + constants/schema to match the fixtures (C# `verify` already exists and runs the corpus).
3. **Python** — extend `metaobjects.render.verify` + constants to match the fixtures (Python `verify` already exists and runs the corpus).
4. **Java** — **deferred** until Java has a `verify`/render tier at all (see "Java prompt tier" below). Until then Java simply does not run the verify corpus, exactly as it does not run the loader or render corpora; this is tracked, not divergence.

Three of the four ports (TS, C#, Python) already have `verify` as of the verify-conformance work, so #2 lands across all three now. The render `maxChars` guard is per-port runtime (TS first; others as they grow a `render`).

---

## Follow-on features (plan-of-record; deprioritized)

### #4 — Prompt snapshot harness (deterministic)

Render each `template.*` against a committed fixture payload via the (deterministic) fixture provider and snapshot the **byte-exact** output; fail CI on drift. This is the cache-stability tripwire (a stray whitespace change that silently busts prompt-prefix caching becomes a reviewable diff) and a payload-bloat-as-diff aid.

- Primary surface: a CLI subcommand (`meta prompt-snapshot [--check]`) mirroring `meta verify`; snapshots committed to the repo; `--check` is the CI gate and never auto-updates.
- Plus a thin `snapshotPrompt()` helper from the render package for consumers who fold it into an existing test runner.
- **Out of scope:** semantic / LLM-as-judge eval (delegated to external tools such as promptfoo/Braintrust). Our job is to render *exactly what prod ships*, deterministically; layered semantic eval is a separate, non-deterministic concern outside byte-conformance.
- **Value:** High for the caching consumer (fragile flat-prefix cache, huge imperative builders); Medium for the non-caching consumer (review-diff aid until/unless caching lands). Note: a port needs a `render` to host this — TS first; the JVM consumer's value is gated on the Java render tier.

### #3 — `verify` machine output (`--json` / `--strict`)

`--json` (machine-readable `{ templates: [{ name, errors:[{code,path}], warnings:[…] }], ok }`) and `--strict` (required-slot/tag warnings become errors / non-zero exit), plus clearer per-template diagnostics + exit codes. **Derivative:** only as valuable as the checks (#2/#4) it surfaces, and lower priority for the current consumers because both can call `verify` as a **library** inside their own test runners (pytest / JUnit) rather than needing a standalone CLI. Build alongside whichever consumer first wants CI gating.

### #1 — Typed prompt-handle codegen (`templateFile()` generator)

Generate, per `template.*` node, a file containing the payload interface(s), a typed render handle (`renderX(payload, provider) => string`), and a typed metadata const (`{ ref, format, requiredSlots, maxChars }`). The emit functions already exist in TS (`generatePayloadInterfaces`, `generateRenderHandle`) but are not wired into a runnable `Generator`. **Weakest fit for the current cohort:** one consumer already passes strongly-typed inputs (a handle adds a layer over an already-typed surface); the other's pain is imperative string-assembly sprawl, which typed wrappers don't address, and adopting it implies first externalizing prompt text (a consumer-side migration). Revisit when a consumer's pain is genuinely untyped call sites *and* externalized text. This is the **one generated artifact that depends on the render runtime library** (per FR-004 §7/R9) — an intentional exception to dep-free codegen.

---

## Cross-language strategy (why reference-first, not freeze-then-big-bang)

A deliberate decision, recorded because it was debated:

- **Spec says *what*; the reference implementation captures *how*.** Subtle pipeline behavior (tag-match precision, partial expansion order, edge cases) cannot be fully pinned in prose — this repo's standing principle. Implementing four ports simultaneously from a prose doc, with no reference and no fixtures to check against, is the "re-derive from spec → subtly-wrong-cross-language" trap. The proven model is **reference (TS) → freeze behavior as conformance fixtures → port each language against that oracle.** This was validated when `verify` itself was ported: TS reference → corpus → C# and Python matched byte-for-byte on the first attempt.
- **Don't gate on the slowest port.** Three of four ports already have `verify`; only Java lacks it, and Java's is behind a loader-restructure plus a from-scratch render/verify tier. Freezing the feature until Java reaches parity delivers value to no consumer sooner and stalls the ready ports for (realistically) months.
- **Asymmetry is tracked, not divergence.** The conformance corpus + per-port expected-failures ledgers are exactly the machinery for "this port doesn't have this yet," converging over time. Temporary per-port feature asymmetry is the normal, healthy state.

## Consumer adoption notes (generic)

- **Low-friction entry, no externalization required:** the verify-time `@requiredTags`/variable-drift checks can be invoked as a **library call on a prompt's existing in-code text** inside a consumer's own test suite — useful immediately, retiring hand-rolled tag/kwarg guards and (for one consumer) some paid live-LLM contract tests.
- **Full value wants externalized prompt text:** snapshotting (#4) and the variable-drift half of `verify` pay off best once prompt text lives in provider-resolved files. Externalizing sprawled inline/imperative prompt text is a **consumer-side migration**, not a MetaObjects feature — sequence it on the consumer's side.

## Java prompt tier (separate, larger track)

The JVM consumer's wins (#2 + #4) are gated on Java first having a `verify`/render tier. Java today has the Mustache template engine (`codegen-mustache`) but no `verify`, no prompt-side render, and no conformance harness on `main`, and is mid loader-restructure. Standing up the Java prompt tier (a `verify` port against the shared corpora + a render path) is its own project, to be scheduled after/alongside the Java conformance harness. This doc does not design it; it records the dependency.

## Out of scope

- `@maxTokens` budget (model-specific tokenizer; non-deterministic).
- Semantic / LLM-as-judge eval (external tools).
- The host-side prompt **assembler** and prompt **content** (consumer-side).
- Naming any specific downstream consumer in committed artifacts (public-repo hygiene).
