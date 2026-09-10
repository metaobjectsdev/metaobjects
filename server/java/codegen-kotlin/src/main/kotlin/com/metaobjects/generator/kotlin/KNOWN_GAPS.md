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
value → set). Notes:

- **Present-value constraint validation (RESOLVED by FR-036).** The handler now
  injects a `jakarta.validation.Validator` and runs `validateValue(<Entity>::class.java,
  field, value)` on each present value → 400 `{"error":"validation"}`, on both the
  vanilla and (FR-036 Program B) the TPH per-subtype update paths. (The prior claim
  that "TS and Python DO validate present values on PATCH" was wrong — before FR-036
  only TS's vanilla path did.) One TPH caveat: the TPH union data class carries no
  constraint annotations, so `validateValue` against it is a structural no-op — a TPH
  PATCH's present-null-on-`@required` is still rejected (explicit guard), but a
  present-VALUE subtype constraint is not enforced (Java, using per-subtype `<Sub>Dto`,
  does enforce it). Minor pre-existing divergence, untested by any gate.
- **Object/map-typed columns: PATCHability is per shape (split by Program D).** The
  blanket rule this bullet used to carry — a `field.object`/`field.map` column is
  EXCLUDED from the patch settable set, so a `PATCH` leaves it untouched — is stale
  for one shape. What the vanilla path's `patchSettableFields` does today, shape by
  shape:
  - `field.object @storage jsonb` (the storage default, single or `@isArray`) —
    SETTABLE: a present value binds via Jackson `treeToValue` into the VO record /
    `List<VO>` and is validated in full; a present `null` clears a nullable column
    or 400s a `@required` one; absent → untouched (the FR-035 tristate). The
    sibling `codegen-spring` module's `KNOWN_GAPS.md` records the shipment as
    cross-port (TS / Python / Java / Kotlin / C#), gated by
    `fixtures/api-contract-conformance/jsonb/scenarios/jsonb-value-object-patch.yaml`.
  - `field.object @storage flattened` — EXCLUDED: the Exposed table materialises it
    as per-subfield columns; there is no single `Table.<field>` to bind.
  - `field.map` — EXCLUDED (`it !is MapField`): dict-of-VO, staged out.
  - `field.string @dbColumnType=jsonb` open-bag — EXCLUDED (`isJsonbOpenBag`):
    create-only (next bullet); its PATCH is the tracked Kotlin follow-up (the
    kotlinx `parseToJsonElement` bridge) the sibling `codegen-spring`
    `KNOWN_GAPS.md` lists under "Still staged out".
  The remaining exclusions are deliberate staging (each for the substrate reason
  above), not per-port bugs — save the map one, which is a live divergence from
  Java and C# (both patch map columns; C#'s G7 records the split). Closing any of
  them is separately-scoped follow-up work, not a piecemeal port fix.
  **TPH residual.** The per-subtype path has its own SSOT —
  `KotlinTphPlan.subtypeSettableFields` still filters `ObjectField` out outright —
  so a VO column on a TPH-rooted entity is skipped on PATCH, the same TPH
  staging-out Java's and C#'s entries record.
  **Close status.** With the jsonb-VO shape settable, what remains here may mean
  the gap this bullet tracked is already closed; that ruling is deliberately NOT
  made here because it needs Program D's intent, which this file does not own. It
  is filed for exactly that decision as
  [issue #359](https://github.com/metaobjectsdev/metaobjects/issues/359). Until
  ruled, the entry stays open against the residuals above.
- **`field.string @dbColumnType=jsonb` open-bag** is a **create-only** column on the
  generated CRUD. The generated `create` writes it (bound from the `@Valid` DTO's
  kotlinx `JsonElement` property — exercised by the `jsonb-open-bag-roundtrip` corpus),
  but the generated `update` does NOT: the raw-JsonNode patch path cannot bind a kotlinx
  `JsonElement` via Jackson `treeToValue`, and the type name must not surface
  un-imported in the controller (the #179 filter/sort guard). So a `PATCH` leaves an
  open-bag column untouched. A consumer needing to PATCH an open-bag column overrides
  the generated update handler. Typed value-object jsonb (`field.object`) is
  object-typed and separately out of the CRUD DTO scope.

## Write-through read-view re-read assumes a 1:1 replica (#214)

**Status:** documented limitation (a cross-port audit finding, D1).

A write-through entity's generated repository/controller re-reads a
create/update through the replica view by primary key using Exposed
`.single()`, which assumes the view surfaces the just-written row. That holds
for a plain `@kind:view` replica (a live query over the write table). A
`@kind:materializedView` (unrefreshed) or a filtered replica that does not
surface the row makes `.single()` throw → HTTP 500, whereas the data-oriented
ports (Python `ObjectManager`, C# routes) degrade to returning the write row
(derived fields absent). A materialized/filtered replica on a write-through
entity is an unusual shape; the graceful table-row fallback (a second, derived-
free row mapper) is deferred until a real consumer needs it.
