# `metaobjects-codegen-kotlin` — known gaps

## FR-010 tolerant `recover()` + output-format prompt fragment

`KotlinOutputParserGenerator` emits, for `template.output` of `@format` json|xml, a
tolerant `recover(text[, opts]): RecoveryResult<<Name>Recovered>` alongside the
existing dual-API `parse`/`safeParse`; `KotlinOutputPromptGenerator` emits
`<Name>OutputPrompt.renderFormat([overrides])`. Both **call the shared JVM
`metaobjects-render` engine** (recover + `OutputFormatRenderer`) — no
reimplementation — so recovery classification and rendered output are
byte-identical to the Java port by construction.

- **Kotlin `recover` returns a nullable mirror, not the strict `Payload`.**
  Kotlin data classes enforce non-null on `@required` fields, so constructing the
  strict `<Name>Payload` from best-effort recovery (which yields `null` for
  lost/malformed fields) would throw — violating the never-throws contract.
  Instead a generated all-nullable `data class <Name>Recovered(val f: T? = null, …)`
  carries the partial result. (Decided 2026-05-29; Tier-2 idiomatic divergence
  from Java, whose records tolerate null. Classification/report is identical.)

- **Two recover overloads (nested gap CLOSED for recover).** The parser now emits
  both:
  - **Self-contained** `recover(text[, opts]): RecoveryResult<<Name>Recovered>` —
    drives the baked `RECOVER_SCHEMA` + `RecoverMap` reads. No runtime loader needed,
    but it does NOT populate nested-object / array-of-object components (those stay
    `null`, with a `/* FR-010: nested recover deferred — use recover(loader, text) */`
    marker). Kept for back-compat callers that have no `MetaDataLoader` and only need
    the scalar/enum surface.
  - **Runtime-delegating** `recover(loader: MetaDataLoader, text[, opts]): RecoveryResult<<Name>Recovered>`
    — resolves this payload's `MetaObject` by its baked `PAYLOAD_FQN` from `loader` and
    delegates to `com.metaobjects.object.recover.MetaObjectRecover` (module
    `metaobjects-om`), which assembles the full object graph (nested objects +
    arrays-of-objects + enum coercion + generalized `@default`) reflection-free. The
    assembled `ValueObject` graph (a `Map<String, Any?>`) is then mapped into the typed
    `<Name>Recovered` mirror graph by generated `from<…Recovered>(Map)` helpers. This is
    the codegen-wrapping-runtime pattern (a generated DAO calling the runtime) and CLOSES
    the nested gap for recover. The nested mirror types are emitted alongside the root
    (`<NestedShort>Recovered?` single / `List<<NestedShort>Recovered>?` array).
  - **Prompt rendering** of nested fields remains a placeholder (the recover gap is the
    one closed here).

- **Runtime classpath:**
  - Self-contained `recover(text)` / `renderFormat()` depend only on
    `com.metaobjects:metaobjects-render` (transitive via `metadata-ktx`).
  - Runtime-delegating `recover(loader, …)` additionally references
    `metaobjects-om` (which transitively brings `render` + `metadata`) and
    `com.metaobjects.loader.MetaDataLoader`. Consumers wanting nested recovery must have
    `metaobjects-om` on the classpath.
