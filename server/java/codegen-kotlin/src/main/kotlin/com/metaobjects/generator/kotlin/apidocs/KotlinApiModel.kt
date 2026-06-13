package com.metaobjects.generator.kotlin.apidocs

/**
 * The per-project Kotlin SDK api-surface IR — the accurate-by-construction enumeration of the
 * generated Kotlin SDK surface (`codegen-kotlin`'s output: data class / Exposed table / Spring
 * controller / validator / filter allowlist / payload / render helper / prompt / output parser /
 * extractor), built from a loaded `MetaDataLoader`.
 *
 * Mirrors the Java `JavaApiModel` / C# `CSharpApiModel` / Python `ApiModel` IR field-for-field
 * (same [ApiSymbolKind] set, same `ApiUnit`/`ApiSymbol`/`FieldShape` shape) so the polyglot doc
 * tree coheres — only the per-symbol Kotlin-idiomatic labels (signatures / usage / import lines /
 * the Exposed data-access framing) differ. The names in every symbol come from the
 * [KotlinNaming] seam (the SAME seam the real generators delegate to), never re-concatenated here.
 */
data class KotlinApiModel(val project: String, val units: List<ApiUnit>)

/** One documented unit (an entity / value object, or a template) + its symbols. */
data class ApiUnit(
    val node: String,
    /** The unit's metadata package (`acme::shop`) — drives the doc-page layout path. */
    val pkg: String,
    /** `"entity"` | `"value"` | `"template"` — drives the index's entities-vs-templates split. */
    val kind: String,
    val symbols: List<ApiSymbol>,
)

/**
 * One documented symbol of the generated Kotlin SDK surface. NAMES come from the [KotlinNaming]
 * seam (never invented), so documented == generated.
 */
data class ApiSymbol(
    val name: String,
    val kind: ApiSymbolKind,
    /** The Kotlin import line the consumer writes to reach this symbol (e.g. `import acme.shop.Order`). */
    val importLine: String,
    /** Human-readable Kotlin signature (e.g. `data class Order`, `GET /api/orders`). */
    val signature: String,
    /** One-line "what you use this for". */
    val usage: String,
    /** Description of the symbol's return surface (nullable). */
    val returns: String? = null,
    /** Payload/model field shapes (may be empty). */
    val fields: List<FieldShape> = emptyList(),
)

/** A documented field: name + Kotlin type + optionality + an optional note (e.g. enum values). */
data class FieldShape(
    val name: String,
    val type: String,
    val optional: Boolean,
    val note: String? = null,
)

/**
 * The documented symbol categories. SAME set + spelling as the Java `ApiSymbolKind` enum
 * (cross-port contract) so a unit's section order + the index summary read identically across
 * the ports. Kotlin's data-access symbol is [DATA_ACCESS] (the Exposed `Table` object), framed in
 * the renderer with a Kotlin/Exposed label rather than a repository-interface label.
 */
enum class ApiSymbolKind {
    MODEL,
    DTO,
    DATA_ACCESS,
    REST,
    VALIDATION,
    EXTRACTOR,
    RENDER,
    PAYLOAD,
    PROMPT,
    OUTPUT_PARSER,
    FILTER,
    TRACE,
}
