package com.metaobjects.generator.kotlin.apidocs

/**
 * Renders the [KotlinApiModel] IR into Kotlin-idiomatic api-doc markdown.
 *
 * One IR, three forms — all derived from the SAME model, never re-derived:
 * - [renderUnitPage] — a per-unit HUMAN page (entity OR template), symbols grouped into ordered
 *   sections + the `**Model / metadata:**` back-link.
 * - [renderIndex] — the consolidated index (README.md), one bullet per unit.
 * - [renderAgentApi] — the token-frugal AGENT form (AGENT-API.md), symbols grouped under their
 *   import line.
 *
 * PRESENTATION ONLY: every symbol name comes from the IR (which keys off the
 * [com.metaobjects.generator.kotlin.KotlinNaming] seam) and every path comes from [DocsPaths] —
 * the renderer never re-derives a name or a path. The section order + headings + the back-link
 * literal mirror the Java / C# / Python renderers so the polyglot doc tree coheres.
 */
class KotlinApiDocsRenderer {

    private companion object {
        // Canonical section order per kind (a unit renders only the kinds it carries). Matches the
        // Java KIND_ORDER. DTO/TRACE are present in the order for cross-port parity even though the
        // Kotlin builder never emits them (see KotlinApiModelBuilder).
        val KIND_ORDER = listOf(
            ApiSymbolKind.MODEL,
            ApiSymbolKind.DTO,
            ApiSymbolKind.DATA_ACCESS,
            ApiSymbolKind.REST,
            ApiSymbolKind.VALIDATION,
            ApiSymbolKind.EXTRACTOR,
            ApiSymbolKind.RENDER,
            ApiSymbolKind.PAYLOAD,
            ApiSymbolKind.PROMPT,
            ApiSymbolKind.OUTPUT_PARSER,
            ApiSymbolKind.FILTER,
            ApiSymbolKind.TRACE,
        )

        fun heading(kind: ApiSymbolKind): String = when (kind) {
            ApiSymbolKind.MODEL -> "Model"
            ApiSymbolKind.DTO -> "DTO"
            ApiSymbolKind.DATA_ACCESS -> "Data access"
            ApiSymbolKind.REST -> "REST"
            ApiSymbolKind.VALIDATION -> "Validation"
            ApiSymbolKind.EXTRACTOR -> "Extractor"
            ApiSymbolKind.RENDER -> "Render"
            ApiSymbolKind.PAYLOAD -> "Payload"
            ApiSymbolKind.PROMPT -> "Prompt"
            ApiSymbolKind.OUTPUT_PARSER -> "Output parser"
            ApiSymbolKind.FILTER -> "Filter"
            ApiSymbolKind.TRACE -> "Trace"
        }

        fun summaryLabel(kind: ApiSymbolKind): String = when (kind) {
            ApiSymbolKind.MODEL -> "model"
            ApiSymbolKind.DTO -> "DTO"
            ApiSymbolKind.DATA_ACCESS -> "data access"
            ApiSymbolKind.REST -> "REST"
            ApiSymbolKind.VALIDATION -> "validation"
            ApiSymbolKind.EXTRACTOR -> "extractor"
            ApiSymbolKind.RENDER -> "render"
            ApiSymbolKind.PAYLOAD -> "payload"
            ApiSymbolKind.PROMPT -> "prompt"
            ApiSymbolKind.OUTPUT_PARSER -> "output parser"
            ApiSymbolKind.FILTER -> "filter"
            ApiSymbolKind.TRACE -> "trace"
        }

        fun mdCell(text: String): String = text.replace("|", "\\|")
    }

    // ------------------------------------------------------------------------
    // Per-unit HUMAN page.
    // ------------------------------------------------------------------------

    /**
     * Render one per-unit human reference page. [modelHref] (when non-null/empty) is a pre-computed
     * relative href back to this unit's model/metadata page — the caller derives it via
     * [DocsPaths.modelCrossHref]; the renderer only places it (as the contract
     * `**Model / metadata:**` back-link).
     */
    fun renderUnitPage(unit: ApiUnit, modelHref: String?): String {
        val sb = StringBuilder()
        sb.append("# ").append(unit.node).append(" API\n")
        if (!modelHref.isNullOrEmpty()) {
            sb.append("\n**Model / metadata:** [").append(unit.node).append("](").append(modelHref).append(")\n")
        }
        sb.append("\n> Imports are package-qualified Kotlin types in the generated source set.\n")

        for (kind in KIND_ORDER) {
            val syms = unit.symbols.filter { it.kind == kind }
            if (syms.isEmpty()) continue
            sb.append("\n## ").append(heading(kind)).append('\n')
            for (sym in syms) {
                sb.append("\n### `").append(sym.signature).append("`\n")
                sb.append('\n').append(sym.usage).append('\n')
                sb.append("\n```kotlin\n").append(sym.importLine).append("\n```\n")
                if (!sym.returns.isNullOrEmpty()) {
                    sb.append("\nReturns: ").append(sym.returns).append('\n')
                }
                if (sym.fields.isNotEmpty()) {
                    sb.append("\n| Field | Type | Required | Notes |\n|---|---|---|---|\n")
                    for (f in sym.fields) {
                        sb.append("| `").append(f.name).append("` | `").append(mdCell(f.type))
                            .append("` | ").append(if (f.optional) "no" else "yes").append(" | ")
                            .append(mdCell(f.note ?: "")).append(" |\n")
                    }
                }
            }
        }
        return sb.toString()
    }

    // ------------------------------------------------------------------------
    // Consolidated index (README.md).
    // ------------------------------------------------------------------------

    /**
     * Render the consolidated api index (one bullet per unit, entities/values vs templates), at the
     * api root (`README.md`). Each unit's href is the relative link from the index to the unit's
     * page in the given [layout].
     */
    fun renderIndex(model: KotlinApiModel, layout: DocsPaths.Layout): String {
        val entities = model.units.filter { it.kind != "template" }.sortedBy { it.node }
        val templates = model.units.filter { it.kind == "template" }.sortedBy { it.node }

        val sb = StringBuilder()
        sb.append("# API Reference\n\nGenerated public API surface, one page per entity and output template.\n")
        if (entities.isNotEmpty()) {
            sb.append("\n## Entities\n\n")
            for (u in entities) appendIndexRow(sb, u, layout)
        }
        if (templates.isNotEmpty()) {
            sb.append("\n## Templates\n\n")
            for (u in templates) appendIndexRow(sb, u, layout)
        }
        return sb.toString()
    }

    private fun appendIndexRow(sb: StringBuilder, u: ApiUnit, layout: DocsPaths.Layout) {
        val href = DocsPaths.surfaceCrossHref("README.md", DocsPaths.docPageOutputPath(layout, u.pkg, u.node))
        sb.append("- [").append(u.node).append("](").append(href).append(") — ")
            .append(summary(u)).append(" (").append(u.symbols.size).append(" symbols)\n")
    }

    private fun summary(unit: ApiUnit): String {
        val parts = mutableListOf<String>()
        for (kind in KIND_ORDER) {
            val n = unit.symbols.count { it.kind == kind }
            if (n == 0) continue
            val label = summaryLabel(kind)
            parts.add(if (n == 1) label else "$n $label")
        }
        return if (parts.isEmpty()) "no public symbols" else parts.joinToString(", ")
    }

    // ------------------------------------------------------------------------
    // Condensed AGENT form (AGENT-API.md).
    // ------------------------------------------------------------------------

    /**
     * Render the condensed agent/LLM form: per unit, symbols grouped under a single import-line
     * header then one compact `` `signature` — usage `` line each. NO prose / field-tables (token
     * budget). Units + symbols keep their IR order.
     */
    fun renderAgentApi(model: KotlinApiModel): String {
        val sb = StringBuilder()
        sb.append("# Agent API Reference\n\nGenerated Kotlin API reference for ").append(model.project)
            .append("; call these exactly as written. Imports are package-qualified in the generated source set.\n")
        for (u in model.units) {
            if (u.symbols.isEmpty()) continue
            sb.append("\n## ").append(u.node).append('\n')
            val groups = LinkedHashMap<String, MutableList<ApiSymbol>>()
            for (s in u.symbols) groups.getOrPut(s.importLine) { mutableListOf() }.add(s)
            for ((importLine, syms) in groups) {
                sb.append("\n`").append(importLine).append("`\n")
                for (s in syms) sb.append("- `").append(s.signature).append("` — ").append(s.usage).append('\n')
            }
        }
        return sb.toString()
    }
}
