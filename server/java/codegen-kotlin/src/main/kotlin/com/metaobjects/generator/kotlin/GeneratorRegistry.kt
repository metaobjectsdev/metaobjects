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
//   filter-allowlist, payload, names, exposed-table, relations, spring-config,
//   stored-proc, validator. (Kotlin has NO `template` generator — the manifest
//   deliberately omits kotlin from it.)

package com.metaobjects.generator.kotlin

import com.metaobjects.generator.direct.MultiFileDirectGeneratorBase

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
data class GeneratorInfo(
    /** Stable, cross-port-consistent id. Equals the registry map key. */
    val name: String,
    /** One-line (no newline) human description for `--list`. */
    val description: String,
    /** NATIVE = recommended `gen` suite; NEUTRAL = `docs`-owned. */
    val tier: GeneratorTier,
    /** The selection axis — see [GeneratorLayer]. Gated cross-port. */
    val layer: GeneratorLayer,
    /** Constructs the generator with sensible defaults. Calling it must not throw. */
    val factory: () -> MultiFileDirectGeneratorBase<*>,
)

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
    ),
    "routes" to GeneratorInfo(
        name = "routes",
        description = "Per-entity Spring REST controller (CRUD endpoint surface).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.API,
        factory = ::KotlinSpringControllerGenerator,
    ),
    "repository" to GeneratorInfo(
        name = "repository",
        description = "Per-entity Kotlin persistence repository base (row-mapper + CRUD + patch).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.PERSISTENCE,
        factory = ::KotlinRepositoryGenerator,
    ),
    "output-parser" to GeneratorInfo(
        name = "output-parser",
        description = "Per-template tolerant output parser (recover-on-receipt).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.CAPABILITY,
        factory = ::KotlinOutputParserGenerator,
    ),
    "output-prompt" to GeneratorInfo(
        name = "output-prompt",
        description = "Per-template output-format prompt fragment generator.",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.CAPABILITY,
        factory = ::KotlinOutputPromptGenerator,
    ),
    "render-helper" to GeneratorInfo(
        name = "render-helper",
        description = "Per-template.output render helper (document/email typed wrappers).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.CAPABILITY,
        factory = ::KotlinRenderHelperGenerator,
    ),
    "extractor" to GeneratorInfo(
        name = "extractor",
        description = "Per-template strict typed extract<Name> helper (strict payload extraction).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.CAPABILITY,
        factory = ::KotlinExtractorGenerator,
    ),
    "filter-allowlist" to GeneratorInfo(
        name = "filter-allowlist",
        description = "Per-entity REST filter allowlist (queryable-field guard).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.API,
        factory = ::KotlinFilterAllowlistGenerator,
    ),
    "payload" to GeneratorInfo(
        name = "payload",
        description = "Per-template payload value object (the strict payload type).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.CAPABILITY,
        factory = ::KotlinPayloadGenerator,
    ),
    "names" to GeneratorInfo(
        name = "names",
        description = "Per-object physical database name constants (table/view name, schema, columns).",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.MODEL,
        factory = ::KotlinNamesGenerator,
    ),
    "exposed-table" to GeneratorInfo(
        name = "exposed-table",
        description = "Per-entity Kotlin Exposed table object.",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.PERSISTENCE,
        factory = ::KotlinExposedTableGenerator,
    ),
    "relations" to GeneratorInfo(
        name = "relations",
        description = "Cross-entity relationship helpers.",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.PERSISTENCE,
        factory = ::KotlinRelationsGenerator,
    ),
    "spring-config" to GeneratorInfo(
        name = "spring-config",
        description = "Spring wiring/configuration for the generated surface.",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.API,
        factory = ::KotlinSpringConfigGenerator,
    ),
    "stored-proc" to GeneratorInfo(
        name = "stored-proc",
        description = "Stored-procedure binding helpers.",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.PERSISTENCE,
        factory = ::KotlinStoredProcGenerator,
    ),
    "validator" to GeneratorInfo(
        name = "validator",
        description = "Per-entity input validator.",
        tier = GeneratorTier.NATIVE,
        layer = GeneratorLayer.API,
        factory = ::KotlinValidatorGenerator,
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
