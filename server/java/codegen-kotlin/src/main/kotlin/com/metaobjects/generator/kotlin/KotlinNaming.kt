package com.metaobjects.generator.kotlin

/**
 * Generated-name seam for the codegen-kotlin generators — the single source of truth for the
 * Kotlin type / route / package names the generators emit. Parallels the Java
 * `com.metaobjects.generator.spring.SpringNaming` seam.
 *
 * Each method below returns EXACTLY the string the corresponding generator concatenates today
 * (verbatim, behaviour-preserving). The generators are routed through these methods so the
 * api-docs IR ([com.metaobjects.generator.kotlin.apidocs.KotlinApiModelBuilder]) shares ONE source
 * of truth for emitted names rather than re-concatenating them — guaranteeing documented ==
 * generated. Do NOT change a literal here without changing the generator and re-verifying the
 * generators' byte output (the snapshot + per-generator tests gate it).
 *
 * Package/FQN splitting stays in [PackageMapping] (the existing seam those generators already
 * share); this object owns only the per-artifact NAME rules.
 */
object KotlinNaming {

    /**
     * Capitalize the first character. Mirrors the `capitalizeFirst` helper duplicated across the
     * template-helper generators ([KotlinRenderHelperGenerator] etc.). A no-op when the first char
     * is already uppercase (the common case — template short names are PascalCase).
     */
    fun capitalizeFirst(s: String): String =
        if (s.isEmpty()) s else s[0].uppercaseChar() + s.substring(1)

    /** [KotlinExposedTableGenerator]: `shortName + "Table"`. */
    fun tableObjectName(shortName: String): String = shortName + "Table"

    /** [KotlinStoredProcGenerator]: `shortName + "Proc"` — the stored-proc callable object. */
    fun procObjectName(shortName: String): String = shortName + "Proc"

    /**
     * Exposed `Table` (via `ColumnSet` / `FieldSet`) declares its own `val` members
     * (`source`, `columns`, `fields`, `index`, …). A generated column `val` of the same
     * name fails to compile — "hides member of supertype and needs an 'override' modifier"
     * — because a column property can't legally override those members. Used as the guard
     * set for [safeColumnProperty].
     */
    val RESERVED_TABLE_MEMBERS: Set<String> = setOf(
        "source", "fields", "columns", "index", "indices", "primaryKey",
        "tableName", "ddl", "foreignKeys", "checkConstraints", "sequences",
        "autoIncColumn", "realFields", "defaultExpression", "generatedSignature",
        "tableNameWithoutScheme", "tableNameWithoutSchemeSanitized",
    )

    /**
     * [KotlinExposedTableGenerator]: the Kotlin property name for a column. Identity for a
     * normal field; a field whose camelCase name collides with an Exposed `Table`/`ColumnSet`
     * member ([RESERVED_TABLE_MEMBERS]) gets a `Column` suffix (e.g. `source` → `sourceColumn`).
     * The PHYSICAL column name is unaffected — only the Kotlin val identifier changes — so the
     * persisted schema is unchanged.
     */
    fun safeColumnProperty(name: String): String =
        if (name in RESERVED_TABLE_MEMBERS) name + "Column" else name

    /** [KotlinSpringControllerGenerator]: `shortName + "Controller"`. */
    fun controllerName(shortName: String): String = shortName + "Controller"

    /** [KotlinFilterAllowlistGenerator]: `shortName + "FilterAllowlist"`. */
    fun filterAllowlistName(shortName: String): String = shortName + "FilterAllowlist"

    /**
     * [KotlinSpringControllerGenerator] / [KotlinM2mSupport]: naive route-segment pluralisation —
     * lowercase + "s" (the same trivial rule TS / C# / Java use for the default route segment).
     */
    fun pluralLowercase(shortName: String): String = shortName.lowercase() + "s"

    /** [KotlinSpringControllerGenerator]: the controller route base `"/api/" + pluralLowercase(shortName)`. */
    fun controllerPath(shortName: String): String = "/api/" + pluralLowercase(shortName)

    /**
     * Output package for template-helper artifacts: `if (pkg.isEmpty()) "prompts" else "$pkg.prompts"`.
     * Shared verbatim by the payload / render-helper / output-prompt / output-parser / extractor
     * generators.
     */
    fun promptsPackage(pkg: String): String = if (pkg.isEmpty()) "prompts" else "$pkg.prompts"

    /** [KotlinPayloadGenerator]: `templateShort + "Payload"`. */
    fun payloadName(templateShort: String): String = templateShort + "Payload"

    /** [KotlinRenderHelperGenerator]: `capitalizeFirst(templateShort) + "RenderHelper"`. */
    fun renderHelperName(templateShort: String): String = capitalizeFirst(templateShort) + "RenderHelper"

    /** [KotlinOutputPromptGenerator]: `templateShort + "Prompt"`. */
    fun promptName(templateShort: String): String = templateShort + "Prompt"

    /** [KotlinOutputParserGenerator]: `templateShort + "Parser"`. */
    fun parserName(templateShort: String): String = templateShort + "Parser"

    /** [KotlinExtractorGenerator]: `templateShort + "Extractor"`. */
    fun extractorName(templateShort: String): String = templateShort + "Extractor"
}
