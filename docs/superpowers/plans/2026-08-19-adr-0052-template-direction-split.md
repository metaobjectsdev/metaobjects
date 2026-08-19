# ADR-0052 — template direction split (outbound vs inbound) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## STATUS — 2026-08-19, branch `adr-0052-template-direction`

Six commits on top of `6c9a39f78`. Phases A and B are **complete and green in all five ports**;
Phase D (TS codegen) is complete; Phases C/E are partial; F, G, H are **not started**.

**Done:**
- ADR-0053 + ADR-0052 amendment + `spec/decisions/README.md` (which also records that the ADR
  index stopped being maintained after ADR-0030 — 0031-0051 are on disk, unlisted).
- Vocabulary in all five ports + `expected-registry.json` + `fixtures/metamodel-docs/expected/`.
  Verified: TS metadata **2404 pass**, C# **903+354+291+46**, Java metadata **1404 / BUILD
  SUCCESS**, Python loader+wrong-subtype **23 pass**, 10/10 gates.
- TS inbound tier re-pointed via `templates/find-inbound.ts`. Gate proven RED before green.
- **An XML reply now emits the tolerant extract and nothing strict** — the strict tier is
  `Schema.parse(JSON.parse(text))` and TS ships no XML parser, so `parse<Name>` could never work.
- **The strict schema now honours `@required`** — it previously emitted every field mandatory, so
  `parse<Name>` threw on a reply that correctly omitted an optional field. Same defect family as
  #309, one tier over: every other port reuses the payload VO, TS re-derives inline.
- Inline test fixtures re-pointed. codegen-ts: **1243 pass / 11 fail**.

**Remaining, in dependency order:**

1. **11 codegen-ts failures.** (a) `fr010-output-codegen` "text-format output gets NO extract
   block" — premise is obsolete, the `@format` gate is gone; rewrite or delete. (b) the
   `xpkg-collision` / ADR-0042 FQN trio — file-based fixtures under `test/fixtures/`, convert like
   the inline ones. (c) `Extractor codegen` tsc-gate + run-proof. (d) `api-docs ACCURACY` ×3 —
   `generators/api-model.ts:820,914` still keys the inbound facts on `template.output`.
   (e) `extractor/render payload import` golden. (f) `outputParser() conformance fixtures` —
   the shared `template-output-simple` fixture.
2. **The trace helper, in EVERY port — a fifth inbound consumer, easy to miss.** It is not one of
   the three generators Phase D/F names, and nothing has moved it yet.
   `trace_helper_generator.py:171-174`, TS `trace-helper-file.ts:116-143`, Java
   `LlmTraceHelperGenerator.java`. Each derives the RESPONSE parse format from the prompt's
   `@format` and must read `@responseFormat` instead.

   The Python site carries a comment asserting *"the SAME rule the output-parser / extractor
   generators use."* **That parity claim is factual — verified**: `output_parser_generator.py:136`,
   `extractor_generator.py:194`, `output_prompt_generator.py:76` and
   `output_format_spec_emitter.py:19` all read `TEMPLATE_ATTR_FORMAT` with
   `TEMPLATE_FORMAT_DEFAULT`, the identical pattern. So the whole cluster moves together; the
   comment must be **updated to name `@responseFormat`, not deleted** — the parity survives the
   move and deleting it would hide that these five sites share one rule.

   The tempting alternative — "reading `@format` is correct for `template.output`, since the output
   body IS the response" — is exactly the conflation ADR-0052 dissolves. Once `template.output` is
   outbound-only its `@format` is the syntax of a document being rendered OUT, and is never a
   response. Do not take that branch.

3. **Phase F — C#, Java, Kotlin, Python codegen.** Note Java has **no extractor generator**, so its
   only enforcement path is the strict parser; do not assume the TS shape.
4. **api-docs in 4 ports** (12 of the 16 Python failures were api-docs) + `verify` in 3 ports.
5. **Phase E remainder** — docs-site fixture + golden, `examples/advanced-modeling` regen (the
   committed `ProgramDescriptionOutput.output.ts` with its impossible `JSON.parse` must vanish),
   `template-output-render-conformance` (outbound; remove only parser-emission assertions),
   Kotlin port-local fixtures (**snapshots have no update flag** — read ACTUAL from the failure).
6. **Phase G** — migration guide, `templates-and-payloads.md`, agent-context skills (2 copies +
   5 byte-gated fixture sets; `references/typescript.md` is the one that omits the tolerant tier
   entirely), roadmap slot reconciliation, CHANGELOG.

**Two findings recorded, not acted on:**
- The tolerant tier is **under**-strict: `orThrow` and `extract<Name>` both fire only on
  `hasLostRequired()`, `MALFORMED` never throws from any shipped helper, and response VOs in the
  corpus mostly declare no `@required`. Deliberate and documented at
  `render/src/extract/types.ts:377-383`, so left alone — but it means the strict tier is currently
  the only thing catching a type-invalid required field.
- `template.toolcall` gets no parser in any port. Before treating that as a gap, settle whether it
  is a parsing concern at all — a provider SDK hands back an already-parsed arguments object.

Challenge records: `~/.claude/challenge-log/adr-0052-inbound-home/` (agreed) and
`~/.claude/challenge-log/strict-tier-survives-tolerant/` (**split** — one arm proposed deleting the
strict tier, the other showed why that cannot happen; both were partly right).

---

**Goal:** Make a template subtype's axis DIRECTION — `template.output` renders outbound only and
generates no parser; the inbound half (response shape, FR-010 output-format fragment,
parser-on-receipt) is driven from `template.prompt @responseRef` + a new `@responseFormat`.

**Architecture:** One attribute moves subtypes (`@promptStyle`: output → prompt), one attribute is
added (`@responseFormat` on prompt), and three generator families change their input filter from
"every `template.output`" to "every `template.prompt` carrying `@responseRef`" in all five ports.
`template.output` keeps `@kind`/`@format`/the email part-refs and keeps its outbound render helper.
Nothing merges: the two subtypes stay separate with near-disjoint attribute sets (ADR-0052 non-goal).

**Tech Stack:** TypeScript (reference port), C#, Java, Kotlin, Python. Byte-gated shared manifests:
`fixtures/registry-conformance/expected-registry.json`, `fixtures/metamodel-docs/expected/`,
`fixtures/agent-context-conformance/*/expected/`.

## Global Constraints

- **Breaking, pre-1.0.** Rides the coordinated breaking slot. Migration guide MUST land in the same
  change under `docs/features/migrations/`.
- **Five ports in lockstep.** `expected-registry.json` is byte-matched by all five; a vocabulary
  change that lands in fewer than five turns `registry-conformance` red.
- **This repository is PUBLIC.** No private/other-project names, no `/home/<user>/` paths — in code,
  docs, fixtures, plans or commit messages. `scripts/ci-local.sh --only gates` runs the leak scan.
- **ADR-0023 strict provenance.** `@responseFormat` must be registered in a metamodel provider in
  every port AND gated by `registry-conformance` before any generator reads it.
- **ADR-0039 own-accessor discipline.** Every template attribute read is RESOLVING (`attr()` /
  `Attr()` / `getMetaAttr()` / `attrs().get()`), never `own*()` — a template may inherit its refs
  through `extends`, and three shipped fixtures rely on it.
- **No `any`** in TypeScript; named constants for every metamodel string (`template-constants.ts`
  and each port's peer).
- **Never `git add -A`.** Stage explicit paths.

### Locked design decisions (mine, not the ADR's — recorded so a reviewer can reject them)

| # | Decision | Why |
|---|---|---|
| D1 | `@responseFormat` is a closed enum **`json \| xml`**, optional, **default `json`** | The inbound tier only ever dispatches on json-vs-xml. Registering `text/html/csv/markdown/spreadsheet` would add members no shipping consumer dispatches on — ADR-0007 Amd 2 / ADR-0040's re-entry bar. Default `json` reproduces `trace-helper-file.ts:120-122` exactly, so the three json fixtures need no edit. |
| D2 | Inbound codegen gates on **`@responseRef` presence**, not on a format value | Declaring a response shape IS the request for a parser. The old `@format ∈ {json,xml}` gate is what let a `text` template get a strict parser but no extractor. |
| D3 | `template.output` generates **no parser, no extractor, no format fragment** | This is what kills the committed `JSON.parse` in `examples/advanced-modeling/src/generated/ProgramDescriptionOutput.output.ts:18` — a markdown document template. A `@kind` filter would NOT have killed it (`@kind` is `document`). |
| D4 | Generated names follow the direction axis: `<Prompt>.response.ts` (was `<Output>.output.ts`), `<Prompt>.responseFormat.ts` (was `<Output>.prompt.ts`) | A parser file named `.output.ts` generated from a prompt reproduces the confusion being removed; `ClassifyPrompt.prompt.ts` is worse still. |

---

## File Structure

**Vocabulary (must change together — byte-gated):**

| File | Responsibility |
|---|---|
| `spec/metamodel/template.json` | ROOT spec. Source of truth for both subtypes' attrs + descriptions. |
| `server/csharp/MetaObjects/SpecMetamodel/template.json` | Committed copy — must byte-match the root spec. |
| `server/python/src/metaobjects/spec_metamodel/template.json` | Committed copy — must byte-match the root spec. |
| `server/typescript/packages/metadata/src/template/template-definition.embedded.ts` | TS embedded registration. |
| `server/typescript/packages/metadata/src/template/template-constants.ts` | `TEMPLATE_ATTR_RESPONSE_FORMAT` + the `json\|xml` closed set. |
| `server/csharp/MetaObjects/Template/TemplateSchema.cs` + `TemplateConstants.cs` | C# registration + constants. |
| `server/java/metadata/.../template/PromptTemplate.java` + `OutputTemplate.java` + `TemplateConstants.java` | Java registration + constants. Java has a node class per subtype; `getPromptStyle()` moves classes. |
| `server/python/src/metaobjects/meta/template/template_constants.py` + `prompt_provider.py` | Python constants + registration. |
| `fixtures/registry-conformance/expected-registry.json` | Byte-matched manifest all five emit. |
| `fixtures/metamodel-docs/expected/types/template.md` (+ `INDEX.md`, `providers.md`) | Generated metamodel docs golden. |

**Loader validation:**

| File | Responsibility |
|---|---|
| `server/python/src/metaobjects/loader/validation_passes.py:138-149` | `_TEMPLATE_SUBTYPE_ONLY_ATTRS` — the only port that has this map. `promptStyle` flips to prompt; `responseFormat` is added as prompt-only. |

**Codegen — inbound tier (re-points from `template.output` to `template.prompt @responseRef`):**

| Port | Files |
|---|---|
| TS | `codegen-ts/src/generators/{output-parser-file,output-prompt-file,extractor-file}.ts` + `codegen-ts/src/templates/{output-parser,output-prompt,extractor,output-format-spec-emitter}.ts` |
| C# | `MetaObjects.Codegen/Generators/{OutputParserGenerator,OutputPromptGenerator,ExtractorGenerator,OutputFormatSpecEmitter}.cs` |
| Java | `codegen-spring/.../spring/{SpringOutputParserGenerator,SpringOutputPromptGenerator,OutputFormatSpecEmitter}.java` |
| Kotlin | `codegen-kotlin/.../kotlin/{KotlinOutputParserGenerator,KotlinOutputPromptGenerator,KotlinExtractorGenerator,KotlinOutputFormatSpecEmitter}.kt` |
| Python | `codegen/generators/{output_parser_generator,output_prompt_generator,extractor_generator}.py` + `codegen/output_format_spec_emitter.py` |

**Codegen — outbound tier (UNCHANGED, keeps `template.output`):** every port's
`RenderHelperGenerator` / `render-helper.ts`. Do not touch. It is the control that proves the
inbound move did not drag the outbound tier with it.

**Consumers of the split:**

| File | Change |
|---|---|
| `server/typescript/packages/cli/src/commands/verify.ts:350-360` | The `template.output` branch stops checking parser drift; the `template.prompt` branch gains it. |
| `server/csharp/MetaObjects.Cli/VerifyCommand.cs`, `server/java/codegen-base/.../TemplateVerify.java` | Same split. |
| `server/typescript/packages/docs-site/src/builders/index-data.ts:48-49` | The `isPrompt ? response : payload` ternary loses its reason to exist — an output no longer has a response half. |
| `codegen-ts/src/generators/api-model.ts:820,914`, `template-doc-builder.ts:305`, `docs-file.ts:140` | Inbound doc facts move to the prompt unit. |

**Docs + migration:**

| File | Change |
|---|---|
| `docs/features/migrations/template-output-becomes-outbound-only.md` | NEW. The adopter's move. |
| `docs/features/templates-and-payloads.md:31-32,282-286,339-343,405` | The subtype table + "reverse direction" section. |
| `agent-context/skills/metaobjects-prompts/SKILL.md` + `references/{typescript,csharp,java,kotlin,python}.md` | Authoring guidance. |
| `server/typescript/packages/sdk/agent-context/**` | The SHIPPED mirror of the above — must stay byte-identical; `fixtures/agent-context-conformance/*/expected/**` gates it. |
| `spec/decisions/ADR-0053-inbound-response-format.md` | NEW. Clears ADR-0037 for `@responseFormat`. |
| `spec/decisions/ADR-0052-...md` | Amend: the open question is now closed by ADR-0053. |
| `spec/decisions/README.md` | Missing entries for ADR-0052 and ADR-0053. |
| `spec/roadmap.md:51-52` | Reconcile the "pre-1.0 slot" claim against the 1.1 milestone. |
| `CHANGELOG.md` | Breaking entry. |

**Fixtures that change:**

| Fixture | Change |
|---|---|
| `fixtures/conformance/template-output-json-simple/` | Inbound-only — becomes a `template.prompt` with `@responseRef` + `@responseFormat: json`. |
| `fixtures/conformance/template-output-xml-simple/` | Same, `@responseFormat: xml`. |
| `fixtures/conformance/flattened-kitchen-sink/input/meta.ai.json` | `productCard` carries `@promptStyle: guide` on an html output — now illegal; drop it. |
| `fixtures/conformance/ai-trace-prompt-nested/`, `ai-trace-sti/` | Add `@responseFormat` where the response is xml. |
| `server/typescript/packages/docs-site/test/fixture/input/acme/ai/meta.ai.yaml` | `npcReviewOutput` collapses into `npcReview @responseFormat: xml`. Golden `index.html` loses the `parses` edge. |
| `examples/advanced-modeling/` | Regenerate — `ProgramDescriptionOutput.output.ts` disappears. |
| `fixtures/template-output-render-conformance/**` | OUTBOUND corpus. Assertions about parser emission are removed; render assertions are NOT weakened (handoff warning). |
| `server/java/codegen-kotlin/src/test/resources/fixtures/template-output-{fr010,parser}/` | Port-local inbound fixtures. |

---

## Phase A — the vocabulary decision

### Task A1: ADR-0053 — where the inbound response format lives

**Files:**
- Create: `spec/decisions/ADR-0053-inbound-response-format.md`
- Modify: `spec/decisions/ADR-0052-template-direction-outbound-vs-inbound.md` (the "Open question" section)
- Modify: `spec/decisions/README.md` (add both 0052 and 0053 — 0052 is missing today)

- [ ] **Step 1: Write ADR-0053**

Nygard format. It must clear ADR-0037's ordered test explicitly:

- **(0) derivable?** No. `template.prompt @format` is already occupied by the prompt body's own
  escaper, and `docs-site/test/fixture/input/acme/ai/meta.ai.yaml` proves the two genuinely differ
  (`@format: text` prompt, response whose `reason` field carries `@xmlText: true`). A third value
  cannot be derived from a two-valued attribute.
- **(1) physical-only?** No — it selects a parser, not a column type.
- **(2) own native type/behaviour?** No — it modifies/configures an existing type ⇒ **attribute**,
  not a subtype and not a `@kind`.
- **Closed set `json | xml`** because those are the only two values any shipping consumer
  dispatches on (`Format.JSON` / `Format.XML`); ADR-0007 Amendment 2's re-entry bar applies to any
  future member.
- **Default `json`**, matching `trace-helper-file.ts:120-122`'s existing fallback, so the change is
  behaviour-preserving for every existing `@responseRef` carrier that is not xml.

Record the rejected alternative (hang it off the response `object.value`) and why: a response shape
may be reused, and binding a syntax to a shape rather than to a call puts the format where the call
cannot override it.

- [ ] **Step 2: Amend ADR-0052's open question**

Replace the "Open question — where `@format` lives on the inbound side" section with a pointer to
ADR-0053 and the ruling. Keep the section (do not delete history); mark it resolved.

- [ ] **Step 3: Add the missing README entries**

`spec/decisions/README.md` lists no ADR-0052. Add 0052 and 0053.

- [ ] **Step 4: Verify no leak**

Run: `scripts/ci-local.sh --only gates`
Expected: PASS (10 gates).

- [ ] **Step 5: Commit**

```bash
git add spec/decisions/ADR-0053-inbound-response-format.md \
        spec/decisions/ADR-0052-template-direction-outbound-vs-inbound.md \
        spec/decisions/README.md
git commit -m "docs(adr): ADR-0053 — the inbound response format is @responseFormat on template.prompt"
```

---

## Phase B — vocabulary, five ports + byte-gated manifests

Every task in this phase must land in ONE commit per port-group or `registry-conformance` is red
between commits. Prefer one commit for the whole phase.

### Task B1: root spec + the two committed copies

**Files:**
- Modify: `spec/metamodel/template.json`
- Modify: `server/csharp/MetaObjects/SpecMetamodel/template.json`
- Modify: `server/python/src/metaobjects/spec_metamodel/template.json`

**Interfaces:**
- Produces: the attribute set every port's registration must mirror exactly.

- [ ] **Step 1: Move `@promptStyle` from `template.output` to `template.prompt`**

Delete the `promptStyle` child from the `template.output` children array (root spec lines 193-206)
and insert it into `template.prompt`'s children, after `responseRef`. Body unchanged except the
description, which must stop saying "output-format":

```json
{
  "type": "attr",
  "subType": "string",
  "name": "promptStyle",
  "min": 0,
  "max": 1,
  "default": "guide",
  "allowedValues": ["guide", "inline", "exampleOnly"],
  "description": "FR-010 response-format fragment presentation: 'guide' (prose list + example), 'inline' (inline placeholders / enum choices), or 'exampleOnly' (filled skeleton). Guidance is never emitted as comments."
}
```

- [ ] **Step 2: Add `@responseFormat` to `template.prompt`**

Insert after `promptStyle`:

```json
{
  "type": "attr",
  "subType": "string",
  "name": "responseFormat",
  "min": 0,
  "max": 1,
  "default": "json",
  "allowedValues": ["json", "xml"],
  "description": "ADR-0053: the syntax of the model's REPLY, read by the parser-on-receipt and the FR-010 response-format fragment. Distinct from @format, which is the syntax of the rendered PROMPT body."
}
```

- [ ] **Step 3: Rewrite both subtypes' `description` + `rules`**

`template.prompt` description — append the inbound sentence:

> An LLM-targeted renderable prompt template (FR-004). Carries the generic reference + governance
> attrs plus the LLM overlay (@maxTokens / @requiredSlots / @model / @responseRef). Its renderable
> body is required via @textRef. A prompt declaring @responseRef also owns the INBOUND half
> (ADR-0052): the parser-on-receipt, the FR-010 response-format fragment (@promptStyle), and the
> reply syntax (@responseFormat).

`template.prompt` rules — append:

> @format is the syntax of the rendered PROMPT body; @responseFormat (ADR-0053) is the syntax of
> the model's REPLY. The inbound codegen tier keys on @responseRef presence, never on @format.

`template.output` description — drop the `@promptStyle` clause:

> An output / serialization template (FR-004): every rendered artifact other than an LLM prompt — a
> document (email, export, docs, config) or an email. Carries the generic reference + governance
> attrs and the @kind + email part-refs. OUTBOUND ONLY (ADR-0052) — it generates no parser.

`template.output` rules — replace the trailing `@promptStyle` clause with:

> @format is a closed enum keyed by the render engine's escaper. template.output is OUTBOUND ONLY
> (ADR-0052): it emits a render helper and nothing that reads a model's reply.

- [ ] **Step 4: Prove the three files are byte-identical in the changed region**

Run:
```bash
diff <(python3 -c "import json,sys;print(json.dumps(json.load(open('spec/metamodel/template.json')),indent=2,sort_keys=True))") \
     <(python3 -c "import json,sys;print(json.dumps(json.load(open('server/csharp/MetaObjects/SpecMetamodel/template.json')),indent=2,sort_keys=True))")
diff <(python3 -c "import json,sys;print(json.dumps(json.load(open('spec/metamodel/template.json')),indent=2,sort_keys=True))") \
     <(python3 -c "import json,sys;print(json.dumps(json.load(open('server/python/src/metaobjects/spec_metamodel/template.json')),indent=2,sort_keys=True))")
```
Expected: no output from either.

### Task B2: TypeScript registration + constants

**Files:**
- Modify: `server/typescript/packages/metadata/src/template/template-constants.ts`
- Modify: `server/typescript/packages/metadata/src/template/template-definition.embedded.ts`
- Test: `server/typescript/packages/metadata/test/fr010-loader-attrs.test.ts`
- Test: `server/typescript/packages/metadata/test/template-definition-completeness.test.ts`

**Interfaces:**
- Produces: `TEMPLATE_ATTR_RESPONSE_FORMAT`, `TEMPLATE_RESPONSE_FORMATS`,
  `RESPONSE_FORMAT_JSON`, `RESPONSE_FORMAT_XML`, `RESPONSE_FORMAT_DEFAULT` — consumed by every TS
  generator task in Phase D.

- [ ] **Step 1: Write the failing test**

Add to `fr010-loader-attrs.test.ts`:

```ts
test("@promptStyle is registered on template.prompt, not template.output", () => {
  const promptDef = registry().find(TYPE_TEMPLATE, TEMPLATE_SUBTYPE_PROMPT);
  const outputDef = registry().find(TYPE_TEMPLATE, TEMPLATE_SUBTYPE_OUTPUT);
  expect(promptDef?.children?.some((c) => c.name === TEMPLATE_ATTR_PROMPT_STYLE)).toBe(true);
  expect(outputDef?.children?.some((c) => c.name === TEMPLATE_ATTR_PROMPT_STYLE)).toBe(false);
});

test("@responseFormat is registered on template.prompt as a json|xml closed enum defaulting to json", () => {
  const def = registry().find(TYPE_TEMPLATE, TEMPLATE_SUBTYPE_PROMPT);
  const attr = def?.children?.find((c) => c.name === TEMPLATE_ATTR_RESPONSE_FORMAT);
  expect(attr).toBeDefined();
  expect(attr?.allowedValues).toEqual([RESPONSE_FORMAT_JSON, RESPONSE_FORMAT_XML]);
  expect(attr?.default).toBe(RESPONSE_FORMAT_DEFAULT);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server/typescript/packages/metadata && bun test fr010-loader-attrs`
Expected: FAIL — `TEMPLATE_ATTR_RESPONSE_FORMAT` is not exported.

- [ ] **Step 3: Add the constants**

In `template-constants.ts`, beside the existing prompt-style block:

```ts
export const TEMPLATE_ATTR_RESPONSE_FORMAT = "responseFormat";
export const RESPONSE_FORMAT_JSON = "json";
export const RESPONSE_FORMAT_XML = "xml";
export const TEMPLATE_RESPONSE_FORMATS = [RESPONSE_FORMAT_JSON, RESPONSE_FORMAT_XML] as const;
export type ResponseFormat = (typeof TEMPLATE_RESPONSE_FORMATS)[number];
export const RESPONSE_FORMAT_DEFAULT: ResponseFormat = RESPONSE_FORMAT_JSON;
```

- [ ] **Step 4: Mirror the root spec into the embedded definition**

Apply Task B1 Steps 1-3 verbatim to `template-definition.embedded.ts`.

- [ ] **Step 5: Run the tests**

Run: `cd server/typescript/packages/metadata && bun test`
Expected: PASS, 2400 baseline + 2 new. `template-definition-completeness.test.ts` proves the
embedded definition matches the root spec.

### Task B3: C#, Java, Kotlin, Python registration

**Files:**
- Modify: `server/csharp/MetaObjects/Template/{TemplateConstants.cs,TemplateSchema.cs}`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/template/{TemplateConstants.java,PromptTemplate.java,OutputTemplate.java}`
- Modify: `server/python/src/metaobjects/meta/template/{template_constants.py,prompt_provider.py}`
- Modify: `server/python/src/metaobjects/loader/validation_passes.py:138-149`

**Interfaces:**
- Consumes: the attribute set from Task B1.
- Produces: `TEMPLATE_ATTR_RESPONSE_FORMAT` / `ATTR_RESPONSE_FORMAT` / `RESPONSE_FORMAT_*` in each
  port's constants module.

- [ ] **Step 1: Java — move the registration and the accessor**

In `PromptTemplate.registerTypes`, after `ATTR_RESPONSE_REF`:

```java
def.optionalAttributeWithConstraints(ATTR_PROMPT_STYLE)
   .ofType(StringAttribute.SUBTYPE_STRING)
   .withEnum(PROMPT_STYLE_GUIDE, PROMPT_STYLE_INLINE, PROMPT_STYLE_EXAMPLE_ONLY);
def.optionalAttributeWithConstraints(ATTR_RESPONSE_FORMAT)
   .ofType(StringAttribute.SUBTYPE_STRING)
   .withEnum(RESPONSE_FORMAT_JSON, RESPONSE_FORMAT_XML);
```

Delete the `ATTR_PROMPT_STYLE` block from `OutputTemplate.registerTypes`. Move `getPromptStyle()`
from `OutputTemplate` to `PromptTemplate` verbatim, and add:

```java
/** Returns @responseFormat if set, else {@link TemplateConstants#RESPONSE_FORMAT_DEFAULT}. */
public String getResponseFormat() {
    if (!hasMetaAttr(ATTR_RESPONSE_FORMAT)) return RESPONSE_FORMAT_DEFAULT;
    String v = getMetaAttr(ATTR_RESPONSE_FORMAT).getValueAsString();
    return v != null ? v : RESPONSE_FORMAT_DEFAULT;
}
```

`TemplateConstants.java:127` carries the javadoc "Only valid on `template.output`" on
`ATTR_PROMPT_STYLE` — flip it to `template.prompt`.

- [ ] **Step 2: C# — same move in `TemplateSchema.cs`**

The `@promptStyle` `AttrDef` at `TemplateSchema.cs:115-119` moves from the output attr list to the
prompt attr list; add a peer `responseFormat` def using `TemplateConstants.TEMPLATE_RESPONSE_FORMATS`
and `RESPONSE_FORMAT_DEFAULT`.

- [ ] **Step 3: Python — constants + provider + the validation map**

Add `TEMPLATE_ATTR_RESPONSE_FORMAT`, `RESPONSE_FORMAT_JSON/XML/DEFAULT`, `RESPONSE_FORMATS` to
`template_constants.py`. In `validation_passes.py:138-149`, `_TEMPLATE_SUBTYPE_ONLY_ATTRS` becomes:

```python
tc.TEMPLATE_ATTR_PROMPT_STYLE: frozenset({tc.TEMPLATE_SUBTYPE_PROMPT}),
tc.TEMPLATE_ATTR_RESPONSE_FORMAT: frozenset({tc.TEMPLATE_SUBTYPE_PROMPT}),
```

(`@kind` / `@subjectRef` / `@htmlBodyRef` / `@textBodyRef` stay output-only.)

- [ ] **Step 4: Kotlin needs no registration change**

Kotlin inherits the JVM loader — `codegen-kotlin` reads the registry Java registers. Confirm by
grep that no Kotlin file registers a template attr:
Run: `grep -rn "ATTR_PROMPT_STYLE\|registerType" server/java/codegen-kotlin/src/main/kotlin/ | head`
Expected: emitter reads only; no registration.

- [ ] **Step 5: Flip the Python wrong-subtype test**

`server/python/tests/unit/test_template_wrong_subtype_attrs.py:53-56` asserts `@promptStyle` on a
prompt is REJECTED; `:81-84` asserts it on an output loads CLEAN. Both invert. **Read the fixture
each assertion runs against before flipping it** — the handoff's `tests-that-pin-the-defect-they-hide`
warning. Add a third case: `@responseFormat` on an output is rejected.

### Task B4: the byte-gated manifests

**Files:**
- Modify: `fixtures/registry-conformance/expected-registry.json`
- Modify: `fixtures/metamodel-docs/expected/types/template.md` (+ `INDEX.md`, `providers.md` if the
  attr counts they print change)
- Modify: `fixtures/registry-conformance/coverage-report.json` if it enumerates attrs

- [ ] **Step 1: Regenerate rather than hand-edit where a generator exists**

Run the TS registry-conformance runner in write mode if one exists; otherwise hand-edit
`expected-registry.json` lines 4023-4024 (the output description/rules), 4083 (the `promptStyle`
child — move it into the prompt block near line 4205), and add the `responseFormat` child.

- [ ] **Step 2: Run registry-conformance in every port**

```
cd server/typescript/packages/metadata && bun test registry-conformance
cd server/csharp && dotnet test --filter RegistryConformance
cd server/java && mvn -o test -Dtest='*RegistryConformance*'
cd server/python && uv run --extra integration pytest -q -k registry_conformance
```
Expected: all green. **A port left out here turns `main` red for every other lane** — the exact
failure mode of the 0.23.0 cut.

- [ ] **Step 3: Commit the whole vocabulary phase as one commit**

```bash
git add spec/metamodel/template.json server/csharp/MetaObjects/SpecMetamodel/template.json \
        server/python/src/metaobjects/spec_metamodel/template.json \
        server/typescript/packages/metadata/src/template/ \
        server/csharp/MetaObjects/Template/ \
        server/java/metadata/src/main/java/com/metaobjects/template/ \
        server/python/src/metaobjects/meta/template/ \
        server/python/src/metaobjects/loader/validation_passes.py \
        server/python/tests/unit/test_template_wrong_subtype_attrs.py \
        server/typescript/packages/metadata/test/ \
        fixtures/registry-conformance/ fixtures/metamodel-docs/expected/
git commit -m "feat(metamodel)!: @promptStyle moves to template.prompt; add @responseFormat (ADR-0052/0053)"
```

---

## Phase C — the failing gate that proves the defect

Before re-pointing anything, write the test that the current code fails. This is the gate the
handoff demands ("Prove any new gate can FAIL before believing it").

### Task C1: pin the absurd artifact

**Files:**
- Test: `server/typescript/packages/codegen-ts/test/output-parser-file.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
test("a template.output emits no parser, extractor, or response-format fragment (ADR-0052)", async () => {
  const root = await loadFixture(`
    { "metadata.root": { "package": "acme::ai", "children": [
      { "object.value": { "name": "Doc", "children": [ { "field.string": { "name": "body" } } ] } },
      { "template.output": { "name": "Welcome", "@payloadRef": "acme::ai::Doc",
                             "@textRef": "mail/welcome", "@format": "markdown" } }
    ] } }`);
  const ctx = genContext(root);
  expect(outputParser().generate(ctx)).toEqual([]);
  expect(extractor().generate(ctx)).toEqual([]);
  expect(outputPrompt().generate(ctx)).toEqual([]);
});

test("a template.prompt carrying @responseRef emits the inbound trio (ADR-0052)", async () => {
  const root = await loadFixture(`
    { "metadata.root": { "package": "acme::ai", "children": [
      { "object.value": { "name": "Req", "children": [ { "field.string": { "name": "q" } } ] } },
      { "object.value": { "name": "Res", "children": [ { "field.string": { "name": "a" } } ] } },
      { "template.prompt": { "name": "Ask", "@payloadRef": "acme::ai::Req",
                             "@responseRef": "acme::ai::Res", "@textRef": "p/ask",
                             "@format": "text", "@responseFormat": "xml" } }
    ] } }`);
  const ctx = genContext(root);
  expect(outputParser().generate(ctx).map((f) => f.path)).toEqual(["Ask.response.ts"]);
  expect(outputPrompt().generate(ctx).map((f) => f.path)).toEqual(["Ask.responseFormat.ts"]);
  expect(outputParser().generate(ctx)[0].content).toContain("Format.XML");
});
```

Note the second test's `@format: text` + `@responseFormat: xml` — that is the docs-site shape the
old design could not express. It is the regression pin for the whole ADR.

- [ ] **Step 2: Run and watch BOTH fail**

Run: `cd server/typescript/packages/codegen-ts && bun test output-parser-file`
Expected: FAIL — the first because the output DOES emit a parser today, the second because
`template.prompt` emits nothing today.

- [ ] **Step 3: Commit the red test**

```bash
git add server/typescript/packages/codegen-ts/test/output-parser-file.test.ts
git commit -m "test(codegen-ts): pin the ADR-0052 direction split (currently red)"
```

---

## Phase D — TypeScript codegen (reference port)

### Task D1: re-point the three inbound generators

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/generators/output-parser-file.ts`
- Modify: `server/typescript/packages/codegen-ts/src/generators/output-prompt-file.ts`
- Modify: `server/typescript/packages/codegen-ts/src/generators/extractor-file.ts`
- Modify: `server/typescript/packages/codegen-ts/src/templates/{output-parser,output-prompt,extractor,output-format-spec-emitter}.ts`

**Interfaces:**
- Consumes: `TEMPLATE_ATTR_RESPONSE_FORMAT`, `RESPONSE_FORMAT_XML`, `RESPONSE_FORMAT_DEFAULT`
  (Task B2), `TEMPLATE_ATTR_RESPONSE_REF` (already exported).
- Produces: `inboundTemplates(root): MetaData[]` and
  `responseShape(root, tmpl): { vo: MetaData; format: ResponseFormat } | undefined` in a new
  `templates/find-inbound.ts` — the single place the direction rule lives, so five call sites
  cannot drift.

- [ ] **Step 1: Write `templates/find-inbound.ts`**

```ts
// The ADR-0052 direction rule, in one place. Every inbound generator calls this;
// none of them re-derives "which templates have a response".
import {
  type MetaData,
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_ATTR_RESPONSE_REF,
  TEMPLATE_ATTR_RESPONSE_FORMAT,
  RESPONSE_FORMAT_DEFAULT,
  RESPONSE_FORMAT_XML,
  type ResponseFormat,
  resolveObjectRef,
} from "@metaobjectsdev/metadata";

/** Every template.prompt that declares a response shape. ADR-0039: resolving. */
export function inboundTemplates(root: MetaData): MetaData[] {
  return root
    .children()
    .filter(
      (c) =>
        c.type === TYPE_TEMPLATE &&
        c.subType === TEMPLATE_SUBTYPE_PROMPT &&
        typeof c.attr(TEMPLATE_ATTR_RESPONSE_REF) === "string",
    );
}

/** Resolve a prompt's response value-object + reply syntax, or undefined if unresolvable. */
export function responseShape(
  root: MetaData,
  tmpl: MetaData,
): { vo: MetaData; ref: string; format: ResponseFormat } | undefined {
  const ref = tmpl.attr(TEMPLATE_ATTR_RESPONSE_REF);
  if (typeof ref !== "string") return undefined;
  // ADR-0042: a bare @responseRef resolves in the template's package.
  const vo = resolveObjectRef(root, ref, tmpl.package ?? tmpl.fileDefaultPackage ?? "").node;
  if (!vo) return undefined;
  const raw = tmpl.attr(TEMPLATE_ATTR_RESPONSE_FORMAT);
  const format: ResponseFormat =
    typeof raw === "string" && raw.toLowerCase() === RESPONSE_FORMAT_XML
      ? RESPONSE_FORMAT_XML
      : RESPONSE_FORMAT_DEFAULT;
  return { vo, ref, format };
}
```

- [ ] **Step 2: Re-point `output-parser-file.ts`**

Replace `findTemplates(ctx.loadedRoot, TEMPLATE_SUBTYPE_OUTPUT)` with `inboundTemplates(ctx.loadedRoot)`
and the emitted path with `` `${dirPrefix}${t.name}.response.ts` ``.

- [ ] **Step 3: Re-point `templates/output-parser.ts`**

`renderOutputParser` changes three things: the subtype guard becomes
`tmpl.subType !== TEMPLATE_SUBTYPE_PROMPT`; the payload lookup reads `@responseRef` via
`responseShape()` instead of `@payloadRef`; and `emitExtractLenient` becomes unconditional (a
declared response always gets the tolerant path — D2), with `formatEnum` from `responseShape().format`.

**Do not change** the emitted body's shape, names, or the ADR-0044 collision logic. The mirror type
stays `<Template>Extracted`; `<Template>Data`/`parse<Template>`/`safeParse<Template>` keep their
names — `<Template>` is now the prompt's name.

- [ ] **Step 4: Re-point `output-prompt-file.ts` + `templates/output-prompt.ts`**

Path becomes `` `${dirPrefix}${t.name}.responseFormat.ts` ``. `templateSupportsPrompt()` is deleted
— its json/xml gate is subsumed by "has a `@responseRef`" (D2). `renderOutputPrompt` reads
`responseShape()`; the emitted function name stays `render<Template>Format`.

- [ ] **Step 5: Re-point `extractor-file.ts` + `templates/extractor.ts`**

Same substitution; the json/xml `continue` guard is deleted. Path stays `<Name>.extractor.ts`.

- [ ] **Step 6: Re-point `output-format-spec-emitter.ts`**

`specLiteral(vo, tmpl, ref)` reads `@promptStyle` off the template — no code change needed, since
the attr is now on the prompt node it is already handed. Verify `TEMPLATE_ATTR_FORMAT` at line 46 is
switched to `TEMPLATE_ATTR_RESPONSE_FORMAT`.

- [ ] **Step 7: Run the Phase C gate**

Run: `cd server/typescript/packages/codegen-ts && bun test output-parser-file`
Expected: PASS — both tests.

- [ ] **Step 8: Run the whole package**

Run: `cd server/typescript/packages/codegen-ts && bun test`
Expected: many goldens fail. That is the Phase E work — do not fix them here.

### Task D2: verify + docs builders + api model

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/verify.ts:350-360`
- Modify: `server/typescript/packages/codegen-ts/src/generators/{api-model.ts,template-doc-builder.ts,docs-file.ts}`
- Modify: `server/typescript/packages/docs-site/src/builders/index-data.ts:44-54`

- [ ] **Step 1: `verify.ts` — move the parser-drift check**

The `TEMPLATE_SUBTYPE_OUTPUT` branch keeps only the render/output-tag checks; the
`TEMPLATE_SUBTYPE_PROMPT` branch gains the `@responseRef` payload-VO drift check.

- [ ] **Step 2: `index-data.ts` — retire the ternary**

```ts
// ADR-0052: only a prompt has a response half. An output renders; it never parses.
const respRef = isPrompt ? response : undefined;
```
The `"parses"` edge label becomes unreachable for `template.output`; keep it for `toolcall` if
`toolcall` still supplies a payload (check `link-graph.ts` before deleting the label).

- [ ] **Step 3: Run**

Run: `cd server/typescript/packages/cli && bun test` and `cd server/typescript/packages/docs-site && bun test`
Expected: golden diffs only, addressed in Phase E.

---

## Phase E — fixtures + goldens

### Task E1: rewrite the inbound conformance fixtures

**Files:**
- Modify: `fixtures/conformance/template-output-json-simple/{input/meta.json,expected.json,README.md}`
- Modify: `fixtures/conformance/template-output-xml-simple/{input/meta.json,expected.json,README.md}`
- Modify: `fixtures/conformance/flattened-kitchen-sink/input/meta.ai.json` + both expected files
- Modify: `fixtures/conformance/ai-trace-prompt-nested/`, `fixtures/conformance/ai-trace-sti/`
- Rename: consider `template-output-json-simple` → `template-prompt-response-json` (a fixture named
  `template-output-*` that declares a prompt is the same naming lie this ADR removes)

- [ ] **Step 1: `template-output-json-simple` becomes a prompt**

```json
{ "template.prompt": {
    "name": "SupportAnswerPrompt",
    "@payloadRef": "acme::support::SupportRequest",
    "@responseRef": "acme::support::SupportAnswer",
    "@textRef": "support/answer",
    "@format": "text",
    "@responseFormat": "json",
    "@promptStyle": "inline"
} }
```
A `SupportRequest` value-object must be added — `@payloadRef` is required on `template.prompt`.

- [ ] **Step 2: xml sibling** — same, `@responseFormat: "xml"`.

- [ ] **Step 3: `flattened-kitchen-sink`** — delete `@promptStyle: "guide"` from the `productCard`
`template.output` (now illegal). Regenerate `expected.json` + `expected-effective.json`.

- [ ] **Step 4: the two ai-trace fixtures** — `ai-trace-prompt-nested` has `@format: "xml"` on the
prompt; that was doing double duty. Set `@responseFormat: "xml"` explicitly and decide what
`@format` should be for the prompt BODY (it is `p/classify`, a text prompt ⇒ `text`). Same for
`ai-trace-sti`'s two json prompts — `@responseFormat` may be omitted (default json), which is the
point of D1.

- [ ] **Step 5: run every port's conformance runner**

```
cd server/typescript/packages/metadata && bun test conformance
cd server/csharp && dotnet test --filter Conformance
cd server/java && mvn -o test
cd server/python && uv run --extra integration pytest -q
```

### Task E2: docs-site fixture + golden

**Files:**
- Modify: `server/typescript/packages/docs-site/test/fixture/input/acme/ai/meta.ai.yaml`
- Modify: `server/typescript/packages/docs-site/test/fixture/golden/index.html`

- [ ] **Step 1: collapse the two nodes into one**

```yaml
- template.prompt:
    name: npcReview
    "@payloadRef": NpcPayload
    "@responseRef": NpcResponse
    "@textRef": ai/npc-review
    "@format": text
    "@responseFormat": xml
    "@dataflow": ingest
```
Delete `npcReviewOutput` entirely. This is the migration guide's worked example — the shape that
motivated the whole ADR.

- [ ] **Step 2: golden**

`index.html:109-110` loses `npcReviewOutput -->|parses| NpcResponse`; `npcReview -->|produces|
NpcResponse` remains. Regenerate rather than hand-edit.

### Task E3: examples + port-local fixtures

- [ ] **Step 1: regenerate `examples/advanced-modeling`**

`ProgramDescriptionOutput.output.ts` must DISAPPEAR. Delete the stale
`examples/advanced-modeling/metaobjects/meta.prompts.yaml:7-12` comment that rationalized it —
it teaches the behaviour being removed.

- [ ] **Step 2: Kotlin's port-local fixtures**

`server/java/codegen-kotlin/src/test/resources/fixtures/template-output-{fr010,parser}/meta.json`
become prompts. **Kotlin snapshots have no update flag** — `KotlinCodegenSnapshotTest` only writes
when the directory is absent. Read the ACTUAL from the failure, verify it against the fixture, and
hand-write the file.

- [ ] **Step 3: `fixtures/template-output-render-conformance/`**

This is the OUTBOUND corpus and stays on `template.output`. Remove only assertions about parser
emission. **Do not weaken `xpkg-collision`** — it is the payload tier's optionality AND collision
oracle (handoff warning).

---

## Phase F — the four remaining ports

### Task F1: C# · Task F2: Java · Task F3: Kotlin · Task F4: Python

Each follows Task D1's shape against that port's files (listed in File Structure). For each port:

- [ ] **Step 1** — port the direction rule into that port's idiom: a single helper answering "which
  templates are inbound" (mirroring `find-inbound.ts`), so the port has one call site, not three.
- [ ] **Step 2** — re-point the parser / prompt-fragment / extractor generators to it.
- [ ] **Step 3** — rename the emitted artifacts per D4 (`<Prompt>Response*` replacing
  `<Output>Parser*` where the port's naming uses the template name).
- [ ] **Step 4** — the outbound `RenderHelperGenerator` is UNTOUCHED. Diff it to prove it.
- [ ] **Step 5** — run that port's full suite. Baselines at `6c9a39f78`: C# 1592 · Kotlin 315 ·
  Python 1733 · Java BUILD SUCCESS. Java: **never `-T`**.

---

## Phase G — docs, skills, migration guide

### Task G1: the migration guide

**Files:**
- Create: `docs/features/migrations/template-output-becomes-outbound-only.md`

- [ ] **Step 1: write it, with the docs-site pair as the worked example**

Must cover: (a) the before/after metadata; (b) the generated-file renames (D4) so an adopter knows
which files to delete; (c) that a `template.output` declared purely to parse a response has no
replacement other than moving to the eliciting prompt; (d) the #309 shape (a Bedrock classification
response) explicitly, since that adopter is in the blast radius; (e) `@promptStyle` moving subtypes;
(f) `@format` vs `@responseFormat`.

### Task G2: authoring guidance

**Files:**
- Modify: `docs/features/templates-and-payloads.md` (lines 31-32, 282-286, 339-343, 405)
- Modify: `agent-context/skills/metaobjects-prompts/SKILL.md` (lines 24-25, 32, 43, 194-221)
  and `references/{typescript,csharp,java,kotlin,python}.md`
- Modify: `server/typescript/packages/sdk/agent-context/**` — the SHIPPED mirror
- Modify: `fixtures/agent-context-conformance/*/expected/**` — the byte gate (5 fixture sets)

- [ ] **Step 1: sweep member VALUES, not constant names**

Grep for the literal strings an author would read, not the code identifiers:
`grep -rn "template.output" --include=*.md . | grep -v node_modules`
Every hit that says an output generates a parser is stale doctrine. The shipped SDK skill is the
one that matters most — it teaches adopters directly.

- [ ] **Step 2: keep the two copies byte-identical**

`agent-context/skills/**` and `server/typescript/packages/sdk/agent-context/skills/**` must match,
and `fixtures/agent-context-conformance/*/expected/**` gates them.

Run: `cd server/typescript/packages/sdk && bun test agent-context`

### Task G3: roadmap, changelog, ADR bookkeeping

- [ ] **Step 1: reconcile the release-slot contradiction**

`spec/roadmap.md:51-52` targets FR-037/FR-038 at **1.1**; ADR-0052 line 3 says it rides "the
coordinated pre-1.0 breaking slot alongside FR-037/FR-038". One is wrong. Decide and fix both.

- [ ] **Step 2: CHANGELOG entry** — BREAKING, with the migration guide link.

- [ ] **Step 3: add FR/ADR rows** for ADR-0052 + ADR-0053 in `spec/roadmap.md`'s decision list.

---

## Phase H — the gate

### Task H1: prove the gates can fail

- [ ] **Step 1: revert the Task D1 fix, run the Phase C test, confirm RED, restore.**
      A gate believed without being seen to fail is the failure mode that let #309 ship for four
      releases.
- [ ] **Step 2: full local CI**

```
scripts/ci-local.sh --only gates
cd server/typescript && bun test          # per-package; do not run bare at repo root
cd server/csharp && dotnet test
cd server/java && mvn -o test             # never -T
cd server/python && uv run --extra integration pytest -q
```
**Never pipe a CI run through `tail`** — the exit status becomes `tail`'s.

- [ ] **Step 3: review + simplify before merge** (code-reviewer AND code-simplifier per unit), then
      the no-mistakes gate on the branch.
