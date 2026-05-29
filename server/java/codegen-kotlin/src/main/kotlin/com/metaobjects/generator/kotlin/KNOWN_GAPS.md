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

- **Bounded mapping scope (Plan KT.1 deferral):** scalar / enum (incl.
  `@enumAlias` folding) / scalar-array fields are mapped. Nested-object and
  object-array recover + prompt rendering are deferred — such a field is a
  `FieldKind.STRING`/`OBJECT` placeholder mapped to `null` (with a
  `/* FR-010: nested … deferred */` marker). The `RecoveryReport` still classifies
  it, so nothing is silently wrong.

- **Runtime classpath:** generated `recover()`/`renderFormat()` depend on
  `com.metaobjects:metaobjects-render` (transitive via `metadata-ktx`). Consumers
  using them must have it on the classpath — same precedent as the render engine.
