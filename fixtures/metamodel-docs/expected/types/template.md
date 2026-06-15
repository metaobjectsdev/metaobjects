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

An output / serialization template (FR-004): every rendered artifact other than an LLM prompt — a document (email, export, docs, config) or an email. Carries the generic reference + governance attrs, the FR-010 @promptStyle, and the @kind + email part-refs.

**Owning provider:** metaobjects-core-types

**Rules:** output is either a document (@kind="document" or absent → renders @textRef in @format to one string) or an email (@kind="email" → renders subject + html + optional text to a structured EmailDocument). The cross-field presence rule is enforced in the loader's validateTemplatePayloadRefs pass: document requires @textRef; email requires @subjectRef AND @htmlBodyRef (with @textBodyRef optional) and carries NO @textRef. @format is a closed enum keyed by the render engine's escaper; @promptStyle (FR-010) selects the output-format prompt presentation and is never emitted as comments.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@format` | string | no | `text` | `text`, `html`, `xml`, `csv`, `json`, `markdown`, `spreadsheet` | metaobjects-prompt | Output format; drives the render engine's escaping/whitespace behavior. |
| `@htmlBodyRef` | string | no |  |  | metaobjects-prompt | Email only: 2-layer logical reference (group/source) to the HTML body text. Required when @kind="email". |
| `@kind` | string | no | `document` | `document`, `email` | metaobjects-prompt | Output shape: 'document' (renders @textRef in @format → one string) or 'email' (renders subject + html + optional text → a structured EmailDocument). |
| `@maxChars` | int | no |  |  | metaobjects-prompt | Size budget for the rendered output, in characters. |
| `@owner` | string | no |  |  | metaobjects-prompt | Governance: the owner of this template. |
| `@payloadRef` | string | yes |  |  | metaobjects-prompt | Reference to the payload (a view-object / projection) this template renders against. |
| `@promptStyle` | string | no | `guide` | `guide`, `inline`, `exampleOnly` | metaobjects-prompt | FR-010 output-format prompt presentation: 'guide' (prose list + example), 'inline' (inline placeholders / enum choices), or 'exampleOnly' (filled skeleton). Guidance is never emitted as comments. |
| `@requiredTags` | string[] | no |  |  | metaobjects-prompt | Output tags the rendered text must contain (drives the verify output-tag check). |
| `@since` | string | no |  |  | metaobjects-prompt | Governance: the version this template was introduced in. |
| `@subjectRef` | string | no |  |  | metaobjects-prompt | Email only: 2-layer logical reference (group/source) to the subject-line text. Required when @kind="email". |
| `@textBodyRef` | string | no |  |  | metaobjects-prompt | Email only: 2-layer logical reference (group/source) to the optional plain-text alternative body. |
| `@textRef` | string | no |  |  | metaobjects-prompt | 2-layer logical reference (group/source) to the body text, resolved by a provider at render time. |

**Allowed children**

_No structural children._

### template.prompt

An LLM-targeted renderable prompt template (FR-004). Carries the generic reference + governance attrs plus the LLM overlay (@maxTokens / @requiredSlots / @model / @responseRef). Its renderable body is required via @textRef.

**Owning provider:** metaobjects-core-types

**Rules:** prompt requires @payloadRef (the typed payload it renders against) AND @textRef (the body text, provider-resolved at render time — enforced in the loader's validateTemplatePayloadRefs pass, not at the attr layer where @textRef is relaxed to optional so template.output email can omit it). @format is a closed enum keyed by the render engine's escaper. @responseRef (optional) names the response value-object the prompt expects and drives typed LLM-call trace derivation.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@format` | string | no | `text` | `text`, `html`, `xml`, `csv`, `json`, `markdown`, `spreadsheet` | metaobjects-prompt | Output format; drives the render engine's escaping/whitespace behavior. |
| `@maxChars` | int | no |  |  | metaobjects-prompt | Size budget for the rendered output, in characters. |
| `@maxTokens` | int | no |  |  | metaobjects-prompt | Token budget for the rendered prompt (LLM-specific). |
| `@model` | string | no |  |  | metaobjects-prompt | Target model id (LLM-specific). |
| `@owner` | string | no |  |  | metaobjects-prompt | Governance: the owner of this template. |
| `@payloadRef` | string | yes |  |  | metaobjects-prompt | Reference to the payload (a view-object / projection) this template renders against. |
| `@requiredSlots` | string[] | no |  |  | metaobjects-prompt | Slots that must resolve at render time (drives the verify check). |
| `@requiredTags` | string[] | no |  |  | metaobjects-prompt | Output tags the rendered text must contain (drives the verify output-tag check). |
| `@responseRef` | string | no |  |  | metaobjects-prompt | Optional ref to the response value-object this prompt expects (peer of @payloadRef; drives typed LLM-call trace derivation). |
| `@since` | string | no |  |  | metaobjects-prompt | Governance: the version this template was introduced in. |
| `@textRef` | string | no |  |  | metaobjects-prompt | 2-layer logical reference (group/source) to the body text, resolved by a provider at render time. |

**Allowed children**

_No structural children._

### template.toolcall

A vendor-agnostic LLM tool-call envelope (ADR-0011). Unlike prompt/output it has NO renderable text body — the body IS the structured output schema resolved via @payloadRef. This is why toolcall is its own subtype rather than template.output + @toolName. Does NOT inherit the generic attrs.

**Owning provider:** metaobjects-core-types

**Rules:** toolcall requires @toolName (the wire tool name surfaced to the LLM) AND @payloadRef (the output value-object the tool produces). @textRef is intentionally absent — a tool-call has no renderable text. Core keeps toolcall vendor-agnostic; vendor wire details (retry semantics, fallback shapes, parallel invocation, cache hints) are added by consumer providers via registry.extend(TYPE_TEMPLATE, "toolcall", { attributes: [...] }). The LLM-facing tool description reuses the @description documentation common attr (added to every type by docProvider), so it is not redeclared here.

**Attributes**

| Attribute | Type | Required | Default | Allowed values | Provider | Description |
| --- | --- | --- | --- | --- | --- | --- |
| `@owner` | string | no |  |  | metaobjects-prompt | Governance: the owner of this toolcall. |
| `@payloadRef` | string | yes |  |  | metaobjects-prompt | Output value-object the tool produces (resolved against the metamodel). |
| `@since` | string | no |  |  | metaobjects-prompt | Governance: the version this toolcall was introduced in. |
| `@toolName` | string | yes |  |  | metaobjects-prompt | Wire tool name surfaced to the LLM (vendor-specific format). |

**Allowed children**

_No structural children._

