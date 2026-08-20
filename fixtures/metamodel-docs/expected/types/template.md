<!-- @generated — DO NOT EDIT.
     Metamodel reference for the `template` type family — each subtype's composed attributes, allowed children, and cardinality.
     Regenerate with: meta docs --metamodel -->

# Metamodel — `template` types

Each section below is one `template.<subType>`. The **Attributes** table lists
the subtype's own + concern-contributed attributes (provider-tagged); universal
documentation attributes are omitted here (see [providers.md](../providers.md)).
**Allowed children** lists the structural child rules with their cardinality
(`min..max`, `*` = unbounded).

### template.base

Abstract base template — the shared root subtype for the fourth pillar (FR-004, ADR-0011). A template is a typed payload bound to either a rendered text artifact (prompt/output) or a tool-call envelope. The base carries no attrs of its own; concrete subtypes add their reference + governance attrs.

**Owning provider:** metaobjects-core-types

**Rules:** A single MetaTemplate node class backs every template subtype (no subType→class dispatch); the subtype selects which reserved-attr set applies. @format (a closed-enum ATTRIBUTE, never a subtype) drives the render engine's escaper/whitespace behavior, so a new format costs one escaper + one enum value rather than a new subtype + cross-language port.

**Attributes**

_No subtype-specific attributes._

**Allowed children**

_No structural children._

### template.output

An output / serialization template (FR-004): every rendered artifact other than an LLM prompt — a document (email, export, docs, config) or an email. Carries the generic reference + governance attrs and the @kind + email part-refs. OUTBOUND ONLY (ADR-0052) — it renders, and generates no parser.

**Owning provider:** metaobjects-core-types

**Rules:** output is either a document (@kind="document" or absent → renders @textRef in @format to one string) or an email (@kind="email" → renders subject + html + optional text to a structured EmailDocument). The cross-field presence rule is enforced in the loader's validateTemplatePayloadRefs pass: document requires @textRef; email requires @subjectRef AND @htmlBodyRef (with @textBodyRef optional) and carries NO @textRef. @format is a closed enum keyed by the render engine's escaper. template.output is OUTBOUND ONLY (ADR-0052): it emits a render helper and nothing that reads a model's reply — the parser-on-receipt, the tolerant extract and the FR-010 response-format fragment all belong to template.prompt @responseRef.

**When to use:** You render a document/email/serialized output from typed data. Declare an output template so the {{fields}} are drift-checked against the payload VO at build time. To parse a model's reply instead, declare @responseRef on the template.prompt that elicits it — never a template.output.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@format` | string | no | `text` | `text`, `html`, `xml`, `csv`, `json`, `markdown`, `spreadsheet` | metaobjects-core-types | Output format; drives the render engine's escaping/whitespace behavior. |
| `@htmlBodyRef` | string | no |  |  | metaobjects-core-types | Email only: 2-layer logical reference (group/source) to the HTML body text. Required when @kind="email". |
| `@kind` | string | no | `document` | `document`, `email` | metaobjects-core-types | Output shape: 'document' (renders @textRef in @format → one string) or 'email' (renders subject + html + optional text → a structured EmailDocument). |
| `@maxChars` | int | no |  |  | metaobjects-core-types | Size budget for the rendered output, in characters. |
| `@owner` | string | no |  |  | metaobjects-core-types | Governance: the owner of this template. |
| `@payloadRef` | string | yes |  |  | metaobjects-core-types | Reference to the payload (a view-object / projection) this template renders against. |
| `@requiredTags` | string[] | no |  |  | metaobjects-core-types | Output tags the rendered text must contain (drives the verify output-tag check). |
| `@since` | string | no |  |  | metaobjects-core-types | Governance: the version this template was introduced in. |
| `@subjectRef` | string | no |  |  | metaobjects-core-types | Email only: 2-layer logical reference (group/source) to the subject-line text. Required when @kind="email". |
| `@textBodyRef` | string | no |  |  | metaobjects-core-types | Email only: 2-layer logical reference (group/source) to the optional plain-text alternative body. |
| `@textRef` | string | no |  |  | metaobjects-core-types | 2-layer logical reference (group/source) to the body text, resolved by a provider at render time. |

**Allowed children**

_No structural children._

### template.prompt

An LLM-targeted renderable prompt template (FR-004). Carries the generic reference + governance attrs plus the LLM overlay (@maxTokens / @requiredSlots / @model / @responseRef). Its renderable body is required via @textRef. A prompt declaring @responseRef also owns the INBOUND half (ADR-0052): the parser-on-receipt, the FR-010 response-format fragment (@promptStyle), and the reply syntax (@responseFormat).

**Owning provider:** metaobjects-core-types

**Rules:** prompt requires @payloadRef (the typed payload it renders against) AND @textRef (the body text, provider-resolved at render time — enforced in the loader's validateTemplatePayloadRefs pass, not at the attr layer where @textRef is relaxed to optional so template.output email can omit it). @format is the syntax of the rendered PROMPT body, a closed enum keyed by the render engine's escaper; @responseFormat (ADR-0053) is the syntax of the model's REPLY. @responseRef (optional) names the response value-object the prompt expects, drives typed LLM-call trace derivation, and is the sole gate on the inbound codegen tier — which keys on its presence, never on a format value.

**When to use:** You are sending text to an LLM. Declare a prompt template with a typed payload so the prompt is versioned, drift-checked against its fields, and cache-stable — instead of string-building it in code. Add @responseRef when you also want the reply parsed into a typed shape.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@format` | string | no | `text` | `text`, `html`, `xml`, `csv`, `json`, `markdown`, `spreadsheet` | metaobjects-core-types | Output format; drives the render engine's escaping/whitespace behavior. |
| `@maxChars` | int | no |  |  | metaobjects-core-types | Size budget for the rendered output, in characters. |
| `@maxTokens` | int | no |  |  | metaobjects-core-types | Token budget for the rendered prompt (LLM-specific). |
| `@model` | string | no |  |  | metaobjects-core-types | Target model id (LLM-specific). |
| `@owner` | string | no |  |  | metaobjects-core-types | Governance: the owner of this template. |
| `@payloadRef` | string | yes |  |  | metaobjects-core-types | Reference to the payload (a view-object / projection) this template renders against. |
| `@promptStyle` | string | no | `guide` | `guide`, `inline`, `exampleOnly` | metaobjects-core-types | FR-010 response-format fragment presentation: 'guide' (prose list + example), 'inline' (inline placeholders / enum choices), or 'exampleOnly' (filled skeleton). Guidance is never emitted as comments. |
| `@requiredSlots` | string[] | no |  |  | metaobjects-core-types | Slots that must resolve at render time (drives the verify check). |
| `@requiredTags` | string[] | no |  |  | metaobjects-core-types | Output tags the rendered text must contain (drives the verify output-tag check). |
| `@responseFormat` | string | no | `json` | `json`, `xml` | metaobjects-core-types | ADR-0053: the syntax of the model's REPLY, read by the parser-on-receipt and the FR-010 response-format fragment. Distinct from @format, which is the syntax of the rendered PROMPT body. Two members because two is what every shipping consumer dispatches on; the other @format members are reserved-not-registered. |
| `@responseRef` | string | no |  |  | metaobjects-core-types | Optional ref to the response value-object this prompt expects (peer of @payloadRef; drives typed LLM-call trace derivation). Its presence is the sole gate on the inbound codegen tier (ADR-0052): parser-on-receipt, tolerant extract, and the FR-010 response-format fragment. |
| `@since` | string | no |  |  | metaobjects-core-types | Governance: the version this template was introduced in. |
| `@textRef` | string | no |  |  | metaobjects-core-types | 2-layer logical reference (group/source) to the body text, resolved by a provider at render time. |

**Allowed children**

_No structural children._

### template.toolcall

A vendor-agnostic LLM tool-call envelope (ADR-0011). Unlike prompt/output it has NO renderable text body — the body IS the structured output schema resolved via @payloadRef. This is why toolcall is its own subtype rather than template.output + @toolName. Does NOT inherit the generic attrs.

**Owning provider:** metaobjects-core-types

**Rules:** toolcall requires @toolName (the wire tool name surfaced to the LLM) AND @payloadRef (the output value-object the tool produces). @textRef is intentionally absent — a tool-call has no renderable text. Core keeps toolcall vendor-agnostic; vendor wire details (retry semantics, fallback shapes, parallel invocation, cache hints) are added by consumer providers via registry.extend(TYPE_TEMPLATE, "toolcall", { attributes: [...] }). The LLM-facing tool description reuses the @description documentation common attr (added to every type by docProvider), so it is not redeclared here.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@maxTokens` | int | no |  |  | metaobjects-core-types | Per-call token budget for the tool-call's structured response (LLM-specific). Vendor-agnostic config; peer of @maxTokens on template.prompt (#237). |
| `@owner` | string | no |  |  | metaobjects-core-types | Governance: the owner of this toolcall. |
| `@payloadRef` | string | yes |  |  | metaobjects-core-types | Output value-object the tool produces (resolved against the metamodel). |
| `@since` | string | no |  |  | metaobjects-core-types | Governance: the version this toolcall was introduced in. |
| `@toolName` | string | yes |  |  | metaobjects-core-types | Wire tool name surfaced to the LLM (vendor-specific format). |

**Allowed children**

_No structural children._

