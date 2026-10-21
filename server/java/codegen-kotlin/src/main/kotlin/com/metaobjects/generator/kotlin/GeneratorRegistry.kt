// ADR-0021 D3 — stable-name generator registry (Kotlin port of the TS reference
// server/typescript/packages/codegen-ts/src/generator-registry.ts).
//
// Generators are identified by a STABLE string id (e.g. `entity`, `routes`,
// `render-helper`) rather than by a language-specific class import / hardcoded
// suite. The id is the cross-port contract: the same logical generator carries
// the same stable name in every port. This is the discoverability + identity
// surface behind a `--list`.
//
// It is ADDITIVE: it powers `--list` and a stable identity. It does NOT change
// what any generator emits, nor how the Maven plugin currently constructs the
// suite. Wiring selection-by-name into the Maven/CLI path is a staged follow-on.
//
// Stable names mirror the canonical manifest exactly for the kotlin slice:
//   entity, routes, output-parser, output-prompt, render-helper, extractor,
//   filter-allowlist, names, exposed-table, relations, spring-config,
//   stored-proc, validator, requirement-tests. (Kotlin has NO `template` generator — the manifest
//   deliberately omits kotlin from it.)

package com.metaobjects.generator.kotlin

import com.metaobjects.generator.Generator
import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase
import com.metaobjects.generator.kotlin.apidocs.DocsPaths
import com.metaobjects.generator.kotlin.apidocs.KotlinApiDocsGenerator
import com.metaobjects.generator.kotlin.apidocs.KotlinApiDocsRenderer
import com.metaobjects.generator.kotlin.apidocs.KotlinApiModel
import com.metaobjects.generator.kotlin.apidocs.KotlinApiModelBuilder

/** Tier of a registered generator (ADR-0020 / ADR-0021 D1). */
enum class GeneratorTier {
    /** Recommended Tier-1 `gen` suite (idiomatic emission). */
    NATIVE,

    /** Tier-2 artifact owned by the neutral docs engine. */
    NEUTRAL,
}

/**
 * The six layers a generator can belong to — the axis an adopter SELECTS BY,
 * mirroring the canonical manifest's `layer` field and gated against it exactly as
 * [GeneratorTier] is.
 *
 * Six, not ten. An earlier draft split [CAPABILITY] four ways, each with ONE member —
 * a layer with one member does no grouping work. The first four layers are app-shape
 * decisions a builder makes; [CAPABILITY] holds the ones the MODEL has already made
 * (you declared a `template.prompt`), which is why they are found by probing a real
 * model rather than by browsing a taxonomy.
 */
enum class GeneratorLayer {
    /** Entity / DTO / value-object modules and the constants beside them. */
    MODEL,

    /** Query helpers, repositories, table objects, stored-proc bindings. */
    PERSISTENCE,

    /** HTTP surface: routes, filter allowlists, validators, wiring. */
    API,

    /** Browser tier: forms, hooks, grids. */
    CLIENT,

    /** Documentation artifacts (on by default; owned by the docs door). */
    DOCS,

    /** Chosen by the model, not by browsing — prompts, parsers, payloads, traces. */
    CAPABILITY;

    /** The manifest's spelling: lower-case. */
    fun manifestValue(): String = name.lowercase()
}

/**
 * One registry entry: stable id + one-line description + tier + a refactor-safe
 * factory. The factory constructs the generator with its no-arg constructor
 * (each Kotlin generator is configured via [MultiFileDirectGeneratorBase.setArgs]
 * at run time, never via the constructor), so calling it must NOT throw —
 * `--list` relies on that.
 */
data class GeneratorInfo @JvmOverloads constructor(
    /** Stable, cross-port-consistent id. Equals the registry map key. */
    val name: String,
    /** One-line (no newline) human description for `--list`. */
    val description: String,
    /** NATIVE = recommended `gen` suite; NEUTRAL = `docs`-owned. */
    val tier: GeneratorTier,
    /** The selection axis — see [GeneratorLayer]. Gated cross-port. */
    val layer: GeneratorLayer,
    /**
     * Constructs the generator with sensible defaults. Calling it must not throw. Typed as
     * [Generator], not [MultiFileDirectGeneratorBase]: a generator that returns its files
     * (`FileEmittingGenerator`, ADR-0034 Amendment 4) is not a per-object one.
     */
    val factory: () -> Generator,
    /**
     * Classpath location of this generator's reference source, as shipped inside this jar
     * (e.g. `META-INF/metaobjects/reference/kotlin/KotlinEntityGenerator.kt`), or `null`
     * when not ejectable. `mvn metaobjects:eject` reads this to resolve `-Dnames`. See
     * `docs/superpowers/specs/2026-09-22-eject-in-every-port-design.md` (JVM section).
     */
    val ejectResourcePath: String? = null,
    /**
     * Fully-qualified names of the classes that hold the rest of this generator's emit, copied
     * by `mvn metaobjects:eject` into the same owned package as the generator: the emitters it
     * writes through. Each is shipped as `<EJECT_RESOURCE_ROOT><SimpleName>.kt`. A class two
     * generators share is copied once. The engine (naming, type mapping, model walks, the
     * generator base) is not listed: it stays in the package (ADR-0034 Amendment 8).
     */
    val ejectWith: List<String> = emptyList(),
    /**
     * Stable names of the Kotlin generators whose output this one's output references: without
     * them in the same `<generators>`, the generated code does not compile, and
     * `mvn metaobjects:generate` refuses the list. `GeneratorRequiresCompileTest` (in
     * `integration-tests-kotlin`) proves each closure compiles over the shared fitness corpus.
     */
    val requires: List<String> = emptyList(),
)

/** Classpath root every ejectable Kotlin generator's reference source is shipped under. */
const val EJECT_RESOURCE_ROOT: String = "META-INF/metaobjects/reference/kotlin/"

/** `<EJECT_RESOURCE_ROOT>/<simple class name>.kt` for an ejectable generator. */
private fun ejectPath(simpleClassName: String): String = EJECT_RESOURCE_ROOT + simpleClassName + ".kt"

/** The enum file writer `entity` calls. */
private val ENUM_EMIT: List<String> = listOf(KotlinEnumEmitter::class.java.name)

/** The decimal wire file `entity`, `routes` and `exposed-table` each write beside their own output. */
private val DECIMAL_WIRE_EMIT: List<String> = listOf(KotlinDecimalWireEmitter::class.java.name)

/** The rest of `api-docs`: the page IR (one file, `KotlinApiModel.kt`, which also holds the unit, symbol, field
 *  and kind types), the builder that fills it, the renderer and the page paths. */
private val API_DOCS_EMIT: List<String> = listOf(
    KotlinApiModel::class.java.name, KotlinApiModelBuilder::class.java.name,
    KotlinApiDocsRenderer::class.java.name, DocsPaths::class.java.name,
)

/** The extraction-mirror writer `output-parser` calls, and the prompt-format-spec writer `output-prompt`
 *  calls (which delegates its literals to the mirror writer). */
private val PARSER_EMIT: List<String> = listOf(KotlinExtractSchemaEmitter::class.java.name)
private val PROMPT_EMIT: List<String> =
    listOf(KotlinOutputFormatSpecEmitter::class.java.name, KotlinExtractSchemaEmitter::class.java.name)

/**
 * The stable-name generator registry. Registers every Kotlin generator that
 * exists so all are discoverable (`--list`) and (in a follow-on) selectable by
 * stable name. Insertion order is the natural default-suite order.
 *
 * Factories reference the generator classes directly (via their constructors)
 * for refactor-safety — renaming/moving a generator class is a compile error
 * here, not a silent registry rot.
 */
val GENERATOR_REGISTRY: Map<String, GeneratorInfo> = linkedMapOf(
    "entity" to GeneratorInfo(
        name = "entity",
        description = "Per-entity Kotlin data class (the entity module).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.MODEL,
        factory = ::KotlinEntityGenerator,
        ejectResourcePath = ejectPath("KotlinEntityGenerator"),
        ejectWith = ENUM_EMIT + DECIMAL_WIRE_EMIT,
    ),
    "routes" to GeneratorInfo(
        name = "routes",
        description = "Per-entity Spring REST controller (CRUD endpoint surface).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.API,
        factory = ::KotlinSpringControllerGenerator,
        ejectResourcePath = ejectPath("KotlinSpringControllerGenerator"),
        ejectWith = DECIMAL_WIRE_EMIT,
        requires = listOf("entity", "exposed-table", "filter-allowlist", "relations"),
    ),
    "repository" to GeneratorInfo(
        name = "repository",
        description = "Per-entity Kotlin persistence repository base (row-mapper + CRUD + patch).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.PERSISTENCE,
        factory = ::KotlinRepositoryGenerator,
        ejectResourcePath = ejectPath("KotlinRepositoryGenerator"),
        requires = listOf("entity", "exposed-table"),
    ),
    "output-parser" to GeneratorInfo(
        name = "output-parser",
        description = "Per-template response parser: a strict parse that rejects a reply not matching " +
            "the @responseRef shape, plus a tolerant, never-throwing extractLenient. [Emitted code " +
            "imports com.metaobjects.object.extract, so the consuming module needs a " +
            "`metaobjects-om` dependency — without it the generated parser does not compile " +
            "and nothing in the build says why.]",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.CAPABILITY,
        factory = ::KotlinOutputParserGenerator,
        ejectResourcePath = ejectPath("KotlinOutputParserGenerator"),
        ejectWith = PARSER_EMIT,
        requires = listOf("entity"),
    ),
    "output-prompt" to GeneratorInfo(
        name = "output-prompt",
        description = "Per-template output-format prompt fragment generator.",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.CAPABILITY,
        factory = ::KotlinOutputPromptGenerator,
        ejectResourcePath = ejectPath("KotlinOutputPromptGenerator"),
        ejectWith = PROMPT_EMIT,
    ),
    "render-helper" to GeneratorInfo(
        name = "render-helper",
        description = "Per-renderable-template render helper (typed wrappers; document/email for a template.output, the document shape for a template.prompt).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.CAPABILITY,
        factory = ::KotlinRenderHelperGenerator,
        ejectResourcePath = ejectPath("KotlinRenderHelperGenerator"),
        requires = listOf("entity"),
    ),
    "extractor" to GeneratorInfo(
        name = "extractor",
        description = "Per-template typed extract<Name> helper: tolerant recovery of the typed response " +
            "from dirty model text; throws only when a @required field is lost.",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.CAPABILITY,
        factory = ::KotlinExtractorGenerator,
        ejectResourcePath = ejectPath("KotlinExtractorGenerator"),
        requires = listOf("entity", "output-parser"),
    ),
    "filter-allowlist" to GeneratorInfo(
        name = "filter-allowlist",
        description = "Per-entity REST filter allowlist (queryable-field guard).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.API,
        factory = ::KotlinFilterAllowlistGenerator,
        ejectResourcePath = ejectPath("KotlinFilterAllowlistGenerator"),
    ),
    "names" to GeneratorInfo(
        name = "names",
        description = "Per-object physical database name constants (table/view name, schema, columns).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.MODEL,
        factory = ::KotlinNamesGenerator,
        ejectResourcePath = ejectPath("KotlinNamesGenerator"),
    ),
    "exposed-table" to GeneratorInfo(
        name = "exposed-table",
        description = "Kotlin Exposed table object per table-backed or view-backed entity or projection, and per view-backed report.",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.PERSISTENCE,
        factory = ::KotlinExposedTableGenerator,
        ejectResourcePath = ejectPath("KotlinExposedTableGenerator"),
        ejectWith = DECIMAL_WIRE_EMIT,
        requires = listOf("entity"),
    ),
    "relations" to GeneratorInfo(
        name = "relations",
        description = "Cross-entity relationship helpers.",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.PERSISTENCE,
        factory = ::KotlinRelationsGenerator,
        ejectResourcePath = ejectPath("KotlinRelationsGenerator"),
        requires = listOf("entity", "exposed-table"),
    ),
    "spring-config" to GeneratorInfo(
        name = "spring-config",
        description = "Spring wiring/configuration for the generated surface.",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.API,
        factory = ::KotlinSpringConfigGenerator,
        ejectResourcePath = ejectPath("KotlinSpringConfigGenerator"),
        requires = listOf("validator"),
    ),
    "stored-proc" to GeneratorInfo(
        name = "stored-proc",
        description = "Stored-procedure binding helpers.",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.PERSISTENCE,
        factory = ::KotlinStoredProcGenerator,
        ejectResourcePath = ejectPath("KotlinStoredProcGenerator"),
    ),
    "validator" to GeneratorInfo(
        name = "validator",
        description = "Per-entity input validator.",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.API,
        factory = ::KotlinValidatorGenerator,
        ejectResourcePath = ejectPath("KotlinValidatorGenerator"),
        requires = listOf("exposed-table"),
    ),
    "api-docs" to GeneratorInfo(
        name = "api-docs",
        description = "Per-entity/template SDK API reference (generated-code API; human + agent forms).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.DOCS,
        factory = ::KotlinApiDocsGenerator,
        ejectResourcePath = ejectPath("KotlinApiDocsGenerator"),
        ejectWith = API_DOCS_EMIT,
    ),
    "requirement-tests" to GeneratorInfo(
        name = "requirement-tests",
        description = "Per-package JUnit Jupiter tests, one per declared requirement, each calling a " +
            "project-owned witness through a generated witness interface. [The project's test " +
            "classpath needs org.junit.jupiter:junit-jupiter-api, and the `testPackage` and " +
            "`witnessClass` args name where the tests go and the class that implements the witnesses.]",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.CAPABILITY,
        factory = ::KotlinRequirementTestsGenerator,
        ejectResourcePath = ejectPath("KotlinRequirementTestsGenerator"),
    ),
)

/** All entries, native-first then neutral, alphabetical within tier. */
fun list(): List<GeneratorInfo> {
    val byName = compareBy<GeneratorInfo> { it.name }
    val all = GENERATOR_REGISTRY.values
    return all.filter { it.tier == GeneratorTier.NATIVE }.sortedWith(byName) +
        all.filter { it.tier == GeneratorTier.NEUTRAL }.sortedWith(byName)
}

/** Resolve an entry by its stable id, or null if unknown. */
fun getGenerator(id: String): GeneratorInfo? = GENERATOR_REGISTRY[id]
