# Templates and payloads (FR-004)

The **fourth pillar** of MetaObjects: making LLM prompt construction (and any other
rendered text artifact — emails, exports, docs, `llms.txt`) a first-class metamodel
capability. A **template** is a typed pair: a logical reference to the prompt /
output text (resolved at runtime by a provider, never inlined in metadata) and a
**payload value-object** that declares exactly what shape of data the template
expects.

This buys four guarantees:

1. **Drift detection** — a renamed field on the source entity breaks the build
   (`Renderer.verify` reports it), not silently degrades a prompt.
2. **Snapshot-testability** — `(payload VO, resolved text) → string` is a pure
   function; pin the rendered output as a fixture.
3. **Cache-stability** — a whitespace change can't silently break exact-prefix
   prompt-cache hits because the rendered output is byte-identical across runs and
   across language ports.
4. **Cross-language conformance** — a Python eval renders exactly what the Java
   production server sends.

The vocabulary is `template.*` (the renderable unit) over a declared payload
shape — an `object.value`, or (since #210) a **sourceless** `object.projection`.
Mustache is the chosen template engine — it has the only published
cross-language spec + conformance suite.

## Two template subtypes

| Subtype | Use case | Carries |
|---|---|---|
| `template.prompt` | LLM-targeted | `@maxTokens`, `@requiredSlots`, `@model` (in addition to the generic attrs) |
| `template.output` | Email / docs / config / export | Just the generic attrs |

Both carry the same generic attributes:

| Attr | Required | Purpose |
|---|---|---|
| `@payloadRef` | yes | The `object.value` — or sourceless `object.projection` (#210) — declaring the payload shape |
| `@textRef` | yes | The 2-layer logical reference `group/source` resolved by a provider |
| `@format` | no | `text` / `html` / `xml` / `csv` / `json` / `markdown` / `spreadsheet` — drives the escaper. Default: `text`. |
| `@maxChars` | no | Build-time size budget |
| `@owner` | no | Governance attribute |
| `@since` | no | Governance attribute |

## Payload fields are declared

A payload is an `object.value` — or a **sourceless** `object.projection`
(#210: no `source.*` child, own or inherited) — whose fields DECLARE the
payload's shape; a prompt's payload is a typed projection you author, so
payload bloat shows up as a diff. Every port's payload codegen is **declared-type-authoritative
(#270)**: a field's generated type comes only from its declared `field.<subType>`
+ `isArray` + `@objectRef`, and a nested payload is a declared `field.object
@objectRef` to another `object.value` (`isArray: true` for a list). An `origin.*`
child on a payload field is **ignored for typing** — it never changes the
generated type, nullability, or the nested-payload set. The caller supplies the
field values at render time.

Derivation and assembly belong to **projections** (`object.projection`), which
carry the origin vocabulary — `origin.passthrough`, `origin.aggregate` (incl.
the `any` / `all` quantifiers and the `collect` array rollup), `origin.computed`
(a closed `@expr` grammar) and `origin.first` (#195) — see
[source-kinds.md](source-kinds.md). #210 draws the host line hard: a
value-hosted field may carry **only `origin.passthrough`** (FR-015 parameter
lineage); the assembly origins (`aggregate` / `computed` / `collection` /
`first`) on an `object.value` fail load with `ERR_SUBTYPE_RULE_VIOLATION`. An
origin-declared payload lives on a **sourceless projection** instead, and
`@payloadRef` / `@responseRef` accept it at the template level. Nested payload
targets (a payload field's `field.object @objectRef`) stay value-only.

## Authoring

The named example: a `WelcomePrompt` greets an `Author` by name and includes
their post count + the first 3 post titles.

### Canonical JSON

```json
{
  "metadata.root": {
    "package": "acme::blog",
    "children": [
      {
        "object.value": {
          "name": "WelcomePayload",
          "children": [
            { "field.string": { "name": "displayName" } },
            { "field.long":   { "name": "postCount" } },
            { "field.object": { "name": "posts", "@objectRef": "PostSummary",
              "isArray": true } }
          ]
        }
      },
      {
        "object.value": {
          "name": "PostSummary",
          "children": [
            { "field.string": { "name": "title" } }
          ]
        }
      },
      {
        "template.prompt": {
          "name": "WelcomePrompt",
          "@payloadRef": "WelcomePayload",
          "@textRef": "lobby/welcome",
          "@format": "xml",
          "@maxTokens": 500
        }
      }
    ]
  }
}
```

### Sigil-free YAML

```yaml
metadata:
  package: acme::blog
  children:
    - object.value:
        name: WelcomePayload
        children:
          - field.string:
              name: displayName
          - field.long:
              name: postCount
          - field.object:
              name: posts
              objectRef: PostSummary
              isArray: true

    - object.value:
        name: PostSummary
        children:
          - field.string:
              name: title

    - template.prompt:
        name: WelcomePrompt
        payloadRef: WelcomePayload
        textRef: lobby/welcome
        format: xml
        maxTokens: 500
```

## Provider-resolved text

`@textRef` is a 2-layer logical reference `group/source` (folder/file ·
table/key · collection/document). At runtime, a configured provider resolves the
reference to the actual template text:

- **`FilesystemProvider`** — L1 = folder, L2 = file. The default for dev.
- **`InMemoryProvider`** — a `Map<String,String>`. Test-only.
- **`ClasspathResourceProvider`** — Java/Kotlin: resolves through `getResourceAsStream`.

A consumer can ship their own provider (RDB / Neo4j / Qdrant) — the engine takes
the `Provider` interface and delegates. Locale, A/B, dynamic, and evolutionary
prompts all live behind the provider seam without touching metadata.

## The rendered output

For the `lobby/welcome` template:

```mustache
<prompt>
<author name="{{displayName}}" posts="{{postCount}}"/>
<posts>
{{#posts}}
  <post title="{{title}}"/>
{{/posts}}
</posts>
</prompt>
```

…and a payload `{ displayName: "Ada", postCount: 12, posts: [{title: "Hello"},
{title: "Mustache"}, {title: "Prompts"}] }`, every port renders **byte-identical**:

```xml
<prompt>
<author name="Ada" posts="12"/>
<posts>
  <post title="Hello"/>
  <post title="Mustache"/>
  <post title="Prompts"/>
</posts>
</prompt>
```

## What each port generates

### TypeScript

`@metaobjectsdev/render` ships the render engine + verify. Payload-VO codegen is
shared with the projection codegen path (the payload is an `object.value` or a
sourceless `object.projection`, #210).

```ts
import { render } from "@metaobjectsdev/render";
import { FilesystemProvider } from "@metaobjectsdev/render/providers";

const out: string = await render({
  ref: "lobby/welcome",
  payload: { displayName: "Ada", postCount: 12, posts: [{ title: "Hello" }] },
  provider: new FilesystemProvider("./prompts"),
  format: "xml",
});
```

### Java

`metaobjects-render` ships `Renderer` + `Provider` (Classpath, Filesystem,
InMemory) + `Verify`. `SpringPayloadGenerator` (in `metaobjects-codegen-spring`)
emits a Java 21 `record` payload per template, typing every component from its
declared field (#270; matches the Kotlin reference). Host code may also pass a
`Map<String,Object>` to the renderer if it doesn't want the generated type.

```java
import com.metaobjects.render.*;

Provider provider = new FilesystemProvider(Path.of("./prompts"));
String out = Renderer.render(RenderRequest.builder()
    .ref("lobby/welcome")
    .payload(new WelcomePromptPayload("Ada", 12L, List.of(new PostSummaryPayload("Hello"))))
    .provider(provider)
    .format("xml")
    .build());
```

```java
// generated/acme/blog/prompts/WelcomePromptPayload.java
public record WelcomePromptPayload(
    String displayName,
    Long postCount,
    java.util.List<PostSummaryPayload> posts
) {}

// generated/acme/blog/prompts/PostSummaryPayload.java
public record PostSummaryPayload(String title) {}
```

### Kotlin

`metaobjects-metadata-ktx` wraps `Renderer` in an idiomatic Kotlin builder.
`KotlinPayloadGenerator` (in `codegen-kotlin`) emits a `@Serializable` payload data
class per template, typing every property from its declared field (#270).

```kotlin
import com.metaobjects.metadata.ktx.render
import com.metaobjects.render.FilesystemProvider
import java.nio.file.Path

val out = render {
    ref = "lobby/welcome"
    payload = WelcomePromptPayload(
        displayName = "Ada",
        postCount = 12,
        posts = listOf(PostSummaryPayload("Hello")),
    )
    provider = FilesystemProvider(Path.of("./prompts"))
    format = "xml"
}
```

```kotlin
// generated/acme/blog/prompts/WelcomePromptPayload.kt
@Serializable
data class WelcomePromptPayload(
    val displayName: String,
    val postCount: Long,
    val posts: List<PostSummaryPayload>,
)

// generated/acme/blog/prompts/PostSummaryPayload.kt
@Serializable
data class PostSummaryPayload(val title: String)
```

### C#

`MetaObjects.Render` ships the render engine + verify. `MetaObjects.Codegen`
ships payload-VO codegen for **`template.output`** parse targets — the strict
record is named after the **value object**, not the template (for this model:
`record WelcomePayload` / `record PostSummary`), with `required` init-only
properties named verbatim after the metadata fields (`displayName`, `postCount`,
`posts`). Nothing is emitted for a `template.prompt`; its render payload is a
plain object/array graph you supply:

```csharp
using MetaObjects.Render;

var provider = new FilesystemProvider("./prompts");
var payload = new Dictionary<string, object?>
{
    ["displayName"] = "Ada",
    ["postCount"] = 12,
    ["posts"] = new[] { new Dictionary<string, object?> { ["title"] = "Hello" } },
};

string output = Renderer.Render(new RenderRequest
{
    Ref = "lobby/welcome",
    Payload = payload,
    Provider = provider,
    Format = "xml",
});
```

### Python

`metaobjects.render` ships the Mustache engine + `Verify`. The Python loader
recognizes `template.*` + `origin.*`. Payload-VO codegen **is** emitted (the
`payload` generator emits a Pydantic `BaseModel` per template, typed from the
declared fields (#270) — see
[Output parsing (FR-006)](#output-parsing-fr-006)), so a consumer can render from
the generated payload type or from a plain `dict`.

`render` takes a `RenderRequest` (only `payload` + `provider` are required; `ref`
defaults to `None`, `format` to `"text"`):

```python
from metaobjects.render import FilesystemProvider
from metaobjects.render.renderer import render, RenderRequest

out = render(RenderRequest(
    payload={
        "displayName": "Ada",
        "postCount": 12,
        "posts": [{"title": "Hello"}],
    },
    provider=FilesystemProvider("./prompts"),
    ref="lobby/welcome",
    format="xml",
))
```

## Output parsing (FR-006)

Symmetric story for the reverse direction: for every declared `template.output`,
codegen emits a typed parser that turns an LLM response (raw text) into the
`@payloadRef` value-object. Reuses the same payload-VO `template.prompt` does;
no new metadata authoring. See [ADR-0010](../../spec/decisions/ADR-0010-template-output-parser-codegen.md)
for the cross-port principle and [FR-006](../superpowers/specs/2026-05-25-fr6-template-output-parser-codegen.md)
for the design.

### Cross-port API

Each port emits the parser in its idiomatic shape — throw-only by default, plus a
Result-style "safe" variant where the language has an idiomatic precedent:

| Port | Throwing API | Result-style API | Substrate |
|---|---|---|---|
| TypeScript | `parseXxx(text): T` | `safeParseXxx(text)` → `{ success, data \| error }` | Zod |
| C# | `XxxParser.Parse(string): T` | `XxxParser.TryParse(text, out T, out string)` → `bool` | `System.Text.Json` |
| Python | `parse_xxx(text: str) -> T` | — (Pythonic norm is throw-only; consumers `try/except`) | Pydantic v2 |
| Kotlin | `XxxParser.parseXxx(text): TPayload` | `XxxParser.safeParseXxx(text): Result<TPayload>` | `kotlinx.serialization.json` |
| Java | `XxxParser.parse(text): TPayload` (throws `JsonProcessingException`) | — (throw-only; the FR-010 `extractLenient(loader, text)` tolerant-extraction variant ships alongside `parse()`) | Jackson `ObjectMapper` (`SpringOutputParserGenerator`) |

The throwing API matches the substrate's native deserialization exception
(Zod `ZodError`, `JsonException`, `ValidationError`, `SerializationException`,
`JsonProcessingException`). The Result-style API wraps the throwing API and
does not throw on validation failure. All five shipped ports satisfy the same
conformance fixture
([`template-output-simple`](../../fixtures/conformance/template-output-simple/)).

### Consumer-side usage (Kotlin example)

```kotlin
import acme.ai.prompts.NpcResponseParser
import acme.ai.prompts.WelcomePromptPayload
import com.metaobjects.metadata.ktx.render

// 1. Render the prompt
val promptText = render {
    ref = "ai/npc-prompt"
    payload = WelcomePromptPayload(scenario = "tavern-encounter", playerLevel = 4)
    provider = FilesystemProvider(Path.of("./prompts"))
}

// 2. Call your LLM provider (out of scope — pick your client)
val llmResponse: String = myLlmClient.complete(promptText)

// 3. Parse the response
val npc = NpcResponseParser.parseNpcResponse(llmResponse)         // throws
val safe = NpcResponseParser.safeParseNpcResponse(llmResponse)    // Result<NpcResponsePayload>
safe.onSuccess { npc -> /* use it */ }.onFailure { ex -> /* log */ }
```

TS, C#, and Python follow the same three-step pattern — render the prompt
via the existing engine, call the LLM client (provider-agnostic — codegen
does NOT emit provider-side schema artifacts), then parse the response with
the generated parser.

### Generated file naming

| Port | File | Class/module |
|---|---|---|
| TypeScript | `<TemplateName>.output.ts` | `parse<TemplateName>` + `safeParse<TemplateName>` functions |
| C# | `<TemplateName>.output.cs` | `static class <TemplateName>Parser` |
| Python | `<template_name>_output_parser.py` | `parse_<template_name>` function + `<TemplateName>Data` BaseModel |
| Kotlin | `<TemplateShortName>Parser.kt` | `object <TemplateShortName>Parser` (same package as the payload class) |

The parser file is a companion to (not a replacement for) the existing payload-VO
file — the parser imports the payload class rather than redeclaring it. `meta verify`
extends to walk `template.output` nodes the same way it walks `template.prompt`,
catching payload-VO ↔ parser drift at build time.

**On malformed metadata, generators behave slightly differently** — TS throws
from `renderOutputParser` (aborts the run); C# / Python / Kotlin warn and skip
the malformed template (the run continues, the affected parser file is not
emitted). In practice the loader's template-validation pass rejects malformed
`@payloadRef` declarations before codegen runs, so this divergence is not
user-visible under normal flow; it only matters for defensive paths in
custom embedding scenarios. Tracked as a cross-port consistency item.

### Reading the extraction report — and one sharp edge

Parsing a model's answer is best-effort, so the parser returns a value **and** an
`ExtractionReport` classifying every field it could not populate:

| verdict | meaning |
|---|---|
| `EXTRACTED` | the document answered it |
| `DEFAULTED` | the document did **not** answer it; the value came from the field's `@default` |
| `LOST_OPTIONAL` | absent, no default, not required |
| `LOST_REQUIRED` | absent, no default, and **required** |
| `MALFORMED` | present but unusable |

The generated failure signal keys on `hasLostRequired()` — the generated extractor throws
on it, and Java's `ExtractionResult.dataOrThrow()` throws iff it is true.

> **A `@default` satisfies `@required`.** An absent field carrying a `@default` is filled
> and classified `DEFAULTED` — so it is **never** `LOST_REQUIRED`, and it can never make
> the generated guard fire.
>
> That is deliberate (a default *is* an answer), but the consequence is easy to miss:
> **declaring a `@default` switches off loss detection for that field.** And it propagates
> through `extends` — adding an innocuous `@default` to a shared *abstract* field silently
> disables loss detection for **every field that inherits it**. A value the model never gave
> you then becomes indistinguishable from one it did: no exception, no warning, a
> healthy-looking log line.
>
> When an absent answer must not be mistaken for a given one, check
> **`hasDefaultedRequired()` / `defaultedRequired()`** alongside `hasLostRequired()`. It names
> exactly the required fields the document failed to answer and that were silently filled:
>
> ```ts
> const { data, report } = parseTriage(raw);
> if (report.hasLostRequired() || report.hasDefaultedRequired()) {
>   // the model did not actually answer everything we required
> }
> ```
>
> (`defaulted()` lists every defaulted field, required or not.) The same accessors exist in
> every port: `defaultedRequired()` / `hasDefaultedRequired()` in TS, Java/Kotlin and C#,
> and `defaulted_required()` / `has_defaulted_required()` in Python.

Note the same reasoning applies to anything you hand-write **downstream** of the parser.
The report is a complete account of what survived *the parser* — a hand-written mapper that
turns an absent value into a plausible one (`Boolean.TRUE.equals(vo.getFlag())` → `false`)
un-catches what the framework caught. Prefer declaring the default in metadata (where it is
reported) over defaulting in code (where it is not).

## Drift detection: `verify`

For every template, `verify` resolves the text, parses the `{{...}}` references,
and checks each one exists on the payload VO. If a template references
`{{authorName}}` but the payload only has `displayName`, the build fails.

| Port | Command |
|---|---|
| TypeScript | `meta verify` (CLI) |
| Java | `mvn meta:verify` (Maven goal) |
| Kotlin | `mvn meta:verify` (same Maven goal) |
| C# | `dotnet meta verify <metadataDir> --templates <root>` |
| Python | `python -m metaobjects.render.verify` |

## Determinism contract

- Arrays only for iteration (no object-key iteration — the engine sorts or rejects).
- No locale/number/date formatting in the engine — pre-format on the payload.
- Pinned trailing-newline + Mustache standalone-tag whitespace rules.
- `@format` drives escaping via an engine-owned escaper registry (NOT the
  Mustache lib's default), identical across ports.
- CSV / spreadsheet escapers neutralize leading `= + - @ \t \r` (OWASP CSV-injection guard).

Every rule is conformance-gated by a fixture in
[`fixtures/render-conformance/`](../../fixtures/render-conformance/).

## Verified by

The following conformance fixtures gate this feature's behavior across ports:

**Template subtypes (metamodel)**

- [`fixtures/conformance/template-output-simple/`](../../fixtures/conformance/template-output-simple/) — `template.output` with `@payloadRef`
- [`fixtures/conformance/template-prompt-simple/`](../../fixtures/conformance/template-prompt-simple/) — `template.prompt` with `@payloadRef`
- [`fixtures/conformance/template-output-and-prompt/`](../../fixtures/conformance/template-output-and-prompt/) — both subtypes coexist on one entity
- [`fixtures/conformance/error-template-payload-ref-unresolved/`](../../fixtures/conformance/error-template-payload-ref-unresolved/) — `@payloadRef` must resolve at load
- [`fixtures/conformance/error-template-prompt-missing-payload-ref/`](../../fixtures/conformance/error-template-prompt-missing-payload-ref/) — `template.prompt` requires `@payloadRef`
- [`fixtures/conformance/error-template-required-slot-missing/`](../../fixtures/conformance/error-template-required-slot-missing/) — required slot declarations are checked

**Origins (`origin.*`) — loader vocabulary** (declares derivation lineage; ignored
for payload typing per #270)

- [`fixtures/conformance/origin-passthrough-simple/`](../../fixtures/conformance/origin-passthrough-simple/) — `origin.passthrough` cross-entity field reference
- [`fixtures/conformance/origin-aggregate-count/`](../../fixtures/conformance/origin-aggregate-count/) — `origin.aggregate @agg=count`
- [`fixtures/conformance/origin-aggregate-sum/`](../../fixtures/conformance/origin-aggregate-sum/) — `origin.aggregate @agg=sum`
- [`fixtures/conformance/origin-multi-level-via/`](../../fixtures/conformance/origin-multi-level-via/) — dotted-path `@via` traversal across hops
- [`fixtures/conformance/origin-collection-simple/`](../../fixtures/conformance/origin-collection-simple/) — `origin.collection` loads on a repeated-row shape
- [`fixtures/conformance/error-origin-bad-via-path/`](../../fixtures/conformance/error-origin-bad-via-path/) — unresolvable `@via` rejected
- [`fixtures/conformance/error-origin-bad-aggregate-fn/`](../../fixtures/conformance/error-origin-bad-aggregate-fn/) — unknown `@agg` rejected
- [`fixtures/conformance/error-origin-passthrough-type-mismatch/`](../../fixtures/conformance/error-origin-passthrough-type-mismatch/) — a `passthrough` field whose `field.<subType>` differs from its `@from` source fails with `ERR_PASSTHROUGH_TYPE_MISMATCH`
- [`fixtures/conformance/error-origin-passthrough-array-mismatch/`](../../fixtures/conformance/error-origin-passthrough-array-mismatch/) — a `passthrough` field whose array-ness differs from its `@from` source fails with `ERR_PASSTHROUGH_TYPE_MISMATCH`
- [`fixtures/conformance/origin-passthrough-convert-optout/`](../../fixtures/conformance/origin-passthrough-convert-optout/) — `@convert: true` acknowledges a deliberate type divergence (no cast generated)

**Render engine output (`fixtures/render-conformance/`)** — byte-identical Mustache output across ports

- [`fixtures/render-conformance/render-example-prompt/`](../../fixtures/render-conformance/render-example-prompt/) — `template.prompt` end-to-end render
- [`fixtures/render-conformance/render-example-email/`](../../fixtures/render-conformance/render-example-email/) — `template.output @format=html` (transactional email)
- [`fixtures/render-conformance/render-example-spreadsheet/`](../../fixtures/render-conformance/render-example-spreadsheet/) — `@format=csv` with header row
- [`fixtures/render-conformance/render-csv-injection/`](../../fixtures/render-conformance/render-csv-injection/) — OWASP CSV-injection escaping (leading `= + - @ \t \r`)

**Render engine semantics** — Mustache-spec behavior pinned cross-port (every port's renderer must emit byte-identical output)

- [`fixtures/render-conformance/render-dotted-path-lookup/`](../../fixtures/render-conformance/render-dotted-path-lookup/) — `{{a.b.c}}` traversal across nested objects
- [`fixtures/render-conformance/render-parent-context-fallthrough/`](../../fixtures/render-conformance/render-parent-context-fallthrough/) — a key missing in the current section falls through to the parent context
- [`fixtures/render-conformance/render-empty-array-falsiness/`](../../fixtures/render-conformance/render-empty-array-falsiness/) — `{{#xs}}…{{/xs}}` over an empty array renders nothing (vs. iterates)
- [`fixtures/render-conformance/render-falsy-values/`](../../fixtures/render-conformance/render-falsy-values/) — `false`, `null`, empty string, `0` — which are truthy for `{{#x}}` sections (per Mustache spec, not JS truthiness)
- [`fixtures/render-conformance/render-inverted-section/`](../../fixtures/render-conformance/render-inverted-section/) — `{{^x}}…{{/x}}` renders when `x` is falsy/absent
- [`fixtures/render-conformance/render-nested-partials/`](../../fixtures/render-conformance/render-nested-partials/) — `{{>partial}}` resolves through the provider, supports nesting
- [`fixtures/render-conformance/render-standalone-tag-stripping/`](../../fixtures/render-conformance/render-standalone-tag-stripping/) — a line containing only a section/partial tag is removed (whitespace + newline)
- [`fixtures/render-conformance/render-raw-html-bypass/`](../../fixtures/render-conformance/render-raw-html-bypass/) — `{{{x}}}` (or `{{&x}}`) emits raw, unescaped under `@format=html`
- [`fixtures/render-conformance/render-trailing-newline-preservation/`](../../fixtures/render-conformance/render-trailing-newline-preservation/) — final-line newline preserved (prompt-cache stability invariant)
- [`fixtures/render-conformance/render-unicode-multibyte/`](../../fixtures/render-conformance/render-unicode-multibyte/) — multibyte input handled without truncation or re-encoding

Cross-port runner coverage: TS / Java / Kotlin / C# / Python all execute these
via their respective conformance runners. See [`docs/CONFORMANCE.md`](../CONFORMANCE.md)
for the per-port pass/skip ledger.

## See also

- [entities.md](entities.md) — `object.value` / sourceless `object.projection` are the payload host types (#210)
- [field-types.md](field-types.md) — fields in payload VOs
- [source-kinds.md](source-kinds.md) — `source.rdb` `@kind: "view"` for materialized payloads (FR-003)
- [migrations-and-drift.md](migrations-and-drift.md) — the verify pillar
- [migrations/value-assembly-origins-and-source-role-shrink.md](migrations/value-assembly-origins-and-source-role-shrink.md) — migrating a pre-#210 payload (assembly origins on a value; nested non-value targets)
- FR-004 spec: [2026-05-22-fr-004-cross-language-prompt-construction-design.md](../superpowers/specs/2026-05-22-fr-004-cross-language-prompt-construction-design.md)
