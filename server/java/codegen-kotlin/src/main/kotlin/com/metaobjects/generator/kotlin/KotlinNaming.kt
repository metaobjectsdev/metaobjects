package com.metaobjects.generator.kotlin

import com.metaobjects.generator.util.RouteNaming

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

    /**
     * [KotlinExposedTableGenerator]: `shortName + "View"` — the read-view Exposed object of a
     * WRITE-THROUGH entity read-view (FR-024 §7, #214). A write-through entity emits TWO Exposed
     * objects: the write `<Short>Table` (from the writable `source.rdb`, derived-free) and this
     * read `<Short>View` (from the read-only replica view source, carrying the derived fields).
     * The distinct suffix keeps the two objects from colliding; this is the SSOT for the read
     * object's name so the repository / controller reads route to the same symbol.
     */
    fun viewObjectName(shortName: String): String = shortName + "View"

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

    /**
     * FR-036 [KotlinEntityGenerator] / [KotlinSpringControllerGenerator]: the per-subtype TPH
     * validation class `shortName + "Validation"`. A discriminator base's union data class is
     * annotation-free (a row of any other subtype stores NULL in a subtype column), so the base
     * controller's per-subtype POST/PATCH validates present values against this annotated,
     * validation-only shape instead. Mirrors the Java port's standalone `<Sub>Dto`.
     */
    fun tphSubtypeValidationName(shortName: String): String = shortName + "Validation"

    /** [KotlinRepositoryGenerator]: `shortName + "RepositoryBase"` — the open persistence base a consumer extends. */
    fun repositoryBaseName(shortName: String): String = shortName + "RepositoryBase"

    /** [KotlinFilterAllowlistGenerator]: `shortName + "FilterAllowlist"`. */
    fun filterAllowlistName(shortName: String): String = shortName + "FilterAllowlist"

    /**
     * [KotlinNamesGenerator]: `shortName + "Names"` — the per-object physical database
     * name constants artifact (table/view name, schema, column names). Mirrors the
     * shipped C# `CSharpNaming.NamesClassName` / TS `<Entity>Names` reference.
     */
    fun namesObjectName(shortName: String): String = shortName + "Names"

    /**
     * [KotlinNamesGenerator]: the SCREAMING_SNAKE member-name segment for a field on the
     * `<Entity>Names` object — the shared prefix of both `<MEMBER>_FIELD` and
     * `<MEMBER>_COLUMN`. (R27, Task 6) [KotlinExposedTableGenerator] builds the SAME
     * string when referencing `<Entity>Names.<MEMBER>_COLUMN` — one shared transform so
     * the table generator's constant REFERENCE and the names generator's constant
     * DECLARATION can never name two different members for the same field.
     */
    fun namesMember(fieldName: String): String = KotlinGenUtil.camelToSnake(fieldName).uppercase()

    /**
     * [KotlinSpringControllerGenerator] / [KotlinM2mSupport]: the REST collection segment —
     * the ENTITY NAME snake_cased and then pluralized (`Author` -> `authors`,
     * `PostCategory` -> `post_categories`). Delegates to [RouteNaming], which Java's
     * generator shares, so the two JVM ports cannot drift apart.
     *
     * It was `shortName.lowercase() + "s"`, and the comment here asserted that was
     * "the same trivial rule TS / C# / Java use". Only Java's matched; TS and C# both
     * pluralized irregularly, and TS separated words. One URL, four spellings.
     */
    fun collectionSegment(shortName: String): String = RouteNaming.collectionSegment(shortName)

    /** [KotlinSpringControllerGenerator]: the controller route base `"/api/" + collectionSegment(shortName)`. */
    fun controllerPath(shortName: String): String = "/api/" + collectionSegment(shortName)

    /**
     * Output package for TEMPLATE-keyed artifacts: `"$pkg.prompts"`, or the root package when the
     * template has no package. Shared verbatim by the render-helper / output-prompt / output-parser /
     * extractor generators. A value object's own types never land here (ADR-0056): its data class
     * and its extraction mirror live in the value object's package.
     *
     * A no-package template stays in the root package, rather than a bare `prompts` package,
     * because its artifacts reference the value object's own data class — and a no-package value
     * object lives in the root package, which Kotlin cannot reference from a named one.
     */
    fun promptsPackage(pkg: String): String = if (pkg.isEmpty()) "" else "$pkg.prompts"

    /**
     * [KotlinExtractSchemaEmitter]: `voShort + "Extracted"` — the all-nullable extraction mirror
     * of a value object, emitted beside it (ADR-0056). Keyed by the VALUE OBJECT's short name,
     * never a template's.
     */
    fun extractedName(voShort: String): String = voShort + "Extracted"

    /** [KotlinRenderHelperGenerator]: `capitalizeFirst(templateShort) + "RenderHelper"`. */
    fun renderHelperName(templateShort: String): String = capitalizeFirst(templateShort) + "RenderHelper"

    /** [KotlinOutputPromptGenerator]: `templateShort + "Prompt"`. */
    /**
     * ADR-0052 D4 — the FR-010 fragment class that tells a model how to format its reply.
     * Renamed from `<Short>Prompt`: generated FROM a `template.prompt` now, the old suffix
     * produced `ClassifyPromptPrompt`. Mirrors Java's `SpringNaming.responseFormatName`.
     */
    fun responseFormatName(templateShort: String): String = templateShort + "ResponseFormat"

    /** [KotlinOutputParserGenerator]: `templateShort + "Parser"`. */
    fun parserName(templateShort: String): String = templateShort + "Parser"

    /** [KotlinExtractorGenerator]: `templateShort + "Extractor"`. */
    fun extractorName(templateShort: String): String = templateShort + "Extractor"

    // ---------------------------------------------------------------------
    // ADR-0038 — reverse-relationship navigation via explicit FK finders.
    //
    // For each FK an entity `E` holds (an `identity.reference`), `E`'s relations
    // file gains an Exposed query function returning the `E` rows matching a given
    // target id. The CROSS-PORT INVARIANT is the FK-FIELD DERIVATION (PascalCase,
    // drop a single trailing `Id`) — unique within an entity by construction, so
    // same-pair FKs (GameSession → Scene ×3) yield three DISTINCT finders, never
    // colliding, with no `@reverseName` vocabulary. The function name is idiomatic
    // (`findBy<FkField>` — the entity is the receiver table, so it is implied).
    // ---------------------------------------------------------------------

    /**
     * The reverse-finder disambiguator segment derived from an FK field name:
     * PascalCase, dropping a single trailing `Id` (but never reducing a bare
     * `id`/`Id` to the empty string). E.g. `currentSceneId` → `CurrentScene`;
     * `playerId` → `Player`; `id` → `Id`.
     */
    fun reverseFinderFkSegment(fkFieldName: String): String {
        val pascal = capitalizeFirst(fkFieldName)
        return if (pascal.length > 2 && pascal.endsWith("Id")) pascal.dropLast(2) else pascal
    }

    /** [KotlinRelationsGenerator]: reverse single-value finder name `findBy<FkField>`. */
    fun reverseFinderName(fkFieldName: String): String = "findBy" + reverseFinderFkSegment(fkFieldName)

    /** [KotlinRelationsGenerator]: reverse batched finder name `findBy<FkField>In`. */
    fun reverseFinderInName(fkFieldName: String): String = reverseFinderName(fkFieldName) + "In"
}
