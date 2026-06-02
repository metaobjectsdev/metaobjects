package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Cross-port conformance for the Kotlin generator registry (ADR-0021 D3). Validates
 * [GENERATOR_REGISTRY] against the CANONICAL stable-name manifest at
 * `fixtures/generator-registry-conformance/registry.json` — the single cross-port
 * source of truth every port's registry is checked against (TS reference:
 * `server/typescript/packages/codegen-ts/src/generator-registry.ts`).
 *
 * Contract for the `kotlin` port:
 *   (1) every stable name the Kotlin registry exposes appears in the manifest;
 *   (2) presence both ways — every manifest entry whose `ports` includes `kotlin`
 *       IS in the Kotlin registry, and the Kotlin registry exposes NO name whose
 *       manifest `ports` omits `kotlin` (i.e. the two sets are EQUAL);
 *   (3) tier agreement — every native manifest name is NATIVE in the registry
 *       (Kotlin has no neutral generators per the manifest).
 *
 * On mismatch this REPORTS the exact diff (missing / extra / tier) so the manifest
 * and registry can be reconciled. It never mutates either. Repo-root resolution
 * mirrors the sibling Kotlin conformance tests (walk up from `user.dir`).
 */
class GeneratorRegistryConformanceTest {

    private val port = "kotlin"

    private val manifestPath: Path = run {
        var p: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (p != null && !Files.exists(p.resolve("fixtures/generator-registry-conformance/registry.json"))) {
            p = p.parent
        }
        assertTrue(
            p != null,
            "could not locate fixtures/generator-registry-conformance/registry.json from user.dir",
        )
        p!!.resolve("fixtures/generator-registry-conformance/registry.json")
    }

    private data class ManifestEntry(val name: String, val tier: String, val ports: Set<String>)

    private fun loadManifest(): List<ManifestEntry> {
        val root: JsonNode = ObjectMapper().readTree(Files.readString(manifestPath))
        val generators = root.get("generators")
        return generators.fieldNames().asSequence().map { name ->
            val node = generators.get(name)
            ManifestEntry(
                name = name,
                tier = node.get("tier").asText(),
                ports = node.get("ports").map { it.asText() }.toSet(),
            )
        }.toList()
    }

    /** (1)+(2): the manifest's kotlin slice equals the Kotlin registry's stable names. */
    @Test
    fun `registry stable names equal the manifest kotlin slice`() {
        val manifest = loadManifest()

        val expected = manifest.filter { port in it.ports }.map { it.name }.toSortedSet()
        val actual = GENERATOR_REGISTRY.keys.toSortedSet()

        val missing = (expected - actual).sorted()
        val extras = (actual - expected).sorted()

        assertTrue(
            missing.isEmpty() && extras.isEmpty(),
            "Kotlin generator registry disagrees with the canonical manifest's `$port` slice " +
                "(fixtures/generator-registry-conformance/registry.json).\n" +
                "  MISSING (manifest says `$port` exposes it, but the registry does not): $missing\n" +
                "  EXTRA  (registry exposes it, but the manifest omits `$port` for it):    $extras\n" +
                "Reconcile by editing the manifest AND the registry together — do not force one to match.",
        )
    }

    /** (3): every native manifest name is NATIVE in the Kotlin registry. */
    @Test
    fun `tiers agree with the manifest`() {
        val manifest = loadManifest()

        val tierMismatches = manifest
            .filter { port in it.ports }
            .mapNotNull { entry ->
                val reg = GENERATOR_REGISTRY[entry.name] ?: return@mapNotNull null
                val expectedTier = when (entry.tier) {
                    "native" -> GeneratorTier.NATIVE
                    "neutral" -> GeneratorTier.NEUTRAL
                    else -> null
                }
                if (expectedTier != null && reg.tier != expectedTier) {
                    "${entry.name}: manifest tier=`${entry.tier}` but registry tier=`${reg.tier}`"
                } else null
            }

        assertTrue(
            tierMismatches.isEmpty(),
            "Kotlin generator registry tier disagrees with the canonical manifest:\n  " +
                tierMismatches.joinToString("\n  "),
        )
    }

    /** Sanity: every registered factory constructs a generator without throwing (powers `--list`). */
    @Test
    fun `every registered factory constructs without throwing`() {
        for ((name, info) in GENERATOR_REGISTRY) {
            val gen = info.factory()
            assertTrue(true, "factory for `$name` produced ${gen::class.simpleName}")
        }
    }

    /** list() returns every entry, native-first then neutral, alphabetical within tier. */
    @Test
    fun `list returns all entries native-first alphabetical within tier`() {
        val listed = list()
        assertEquals(GENERATOR_REGISTRY.size, listed.size, "list() must return every entry")
        assertEquals(
            GENERATOR_REGISTRY.keys.toSortedSet(),
            listed.map { it.name }.toSortedSet(),
            "list() names must equal the registry keys",
        )
    }
}
