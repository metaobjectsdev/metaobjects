# `metaobjects-codegen-kotlin` — known gaps

## FR-010 tolerant `extractLenient()` + output-format prompt fragment

`KotlinOutputParserGenerator` emits, for `template.output` of `@format` json|xml, a
tolerant `extractLenient(text[, opts]): ExtractionResult<<Name>Extracted>` alongside the
existing dual-API `parse`/`safeParse`; `KotlinOutputPromptGenerator` emits
`<Name>OutputPrompt.renderFormat([overrides])`. Both **call the shared JVM
`metaobjects-render` engine** (extract + `OutputFormatRenderer`) — no
reimplementation — so extraction classification and rendered output are
byte-identical to the Java port by construction.

- **Kotlin `extract` returns a nullable mirror, not the strict `Payload`.**
  Kotlin data classes enforce non-null on `@required` fields, so constructing the
  strict `<Name>Payload` from best-effort extraction (which yields `null` for
  lost/malformed fields) would throw — violating the never-throws contract.
  Instead a generated all-nullable `data class <Name>Extracted(val f: T? = null, …)`
  carries the partial result. (Decided 2026-05-29; Tier-2 idiomatic divergence
  from Java, whose records tolerate null. Classification/report is identical.)

- **Two extract overloads (nested gap CLOSED for extract).** The parser now emits
  both:
  - **Self-contained** `extractLenient(text[, opts]): ExtractionResult<<Name>Extracted>` —
    drives the baked `EXTRACT_SCHEMA` + `ExtractMap` reads. No runtime loader needed,
    but it does NOT populate nested-object / array-of-object components (those stay
    `null`, with a `/* FR-010: nested extract deferred — use extractLenient(loader, text) */`
    marker). Kept for back-compat callers that have no `MetaDataLoader` and only need
    the scalar/enum surface.
  - **Runtime-delegating** `extractLenient(loader: MetaDataLoader, text[, opts]): ExtractionResult<<Name>Extracted>`
    — resolves this payload's `MetaObject` by its baked `PAYLOAD_FQN` from `loader` and
    delegates to `com.metaobjects.object.extract.MetaObjectExtractor` (module
    `metaobjects-om`), which assembles the full object graph (nested objects +
    arrays-of-objects + enum coercion + generalized `@default`) reflection-free. The
    assembled `ValueObject` graph (a `Map<String, Any?>`) is then mapped into the typed
    `<Name>Extracted` mirror graph by generated `from<…Extracted>(Map)` helpers. This is
    the codegen-wrapping-runtime pattern (a generated DAO calling the runtime) and CLOSES
    the nested gap for extract. The nested mirror types are emitted alongside the root
    (`<NestedShort>Extracted?` single / `List<<NestedShort>Extracted>?` array).
  - **Prompt rendering** of nested fields remains a placeholder (the extract gap is the
    one closed here).

- **Runtime classpath:**
  - Self-contained `extractLenient(text)` / `renderFormat()` depend only on
    `com.metaobjects:metaobjects-render` (transitive via `metadata-ktx`).
  - Runtime-delegating `extractLenient(loader, …)` additionally references
    `metaobjects-om` (which transitively brings `render` + `metadata`) and
    `com.metaobjects.loader.MetaDataLoader`. Consumers wanting nested extraction must have
    `metaobjects-om` on the classpath.

## FR-035 partial-PATCH (present-key tristate)

The generated `@RestController`'s PATCH/PUT handler binds the raw `JsonNode` and
per-field-binds present values via the Spring `ObjectMapper` (absent → untouched;
explicit null → clears a nullable column or 400 on a `@required` field; present
value → set). Two deliberate gaps:

- **Present-value constraint validation** is NOT run on PATCH. Dropping `@Valid`
  means `@Size` / `@Pattern` / `@NotBlank` / `@Min` / `@Max` (emitted by
  `validationAnnotations`) no longer fire on a PATCH body's present values — only a
  present-null-on-`@required` → 400. This matches the C#/Java partial-PATCH state; TS
  and Python DO validate present values on PATCH. A cross-port PATCH-4 follow-up.
- **`field.string @dbColumnType=jsonb` open-bag** is a **create-only** column on the
  generated CRUD. The generated `create` writes it (bound from the `@Valid` DTO's
  kotlinx `JsonElement` property — exercised by the `jsonb-open-bag-roundtrip` corpus),
  but the generated `update` does NOT: the raw-JsonNode patch path cannot bind a kotlinx
  `JsonElement` via Jackson `treeToValue`, and the type name must not surface
  un-imported in the controller (the #179 filter/sort guard). So a `PATCH` leaves an
  open-bag column untouched. A consumer needing to PATCH an open-bag column overrides
  the generated update handler. Typed value-object jsonb (`field.object`) is
  object-typed and separately out of the CRUD DTO scope.
