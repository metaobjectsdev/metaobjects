package com.metaobjects.codegen.kotlin.apidocs

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Cross-port api-docs LAYOUT conformance gate — the KOTLIN half (Phase 0 RED).
 *
 * This is the failing runner mandated by Phase 0 of the cross-port SDK-docs plan
 * (`docs/superpowers/plans/2026-06-13-cross-port-sdk-docs.md`). It enforces, from the Kotlin
 * module's test surface, that a native Kotlin SDK-docs surface (`api/kotlin`) must resolve to
 * the SAME paths + back-link the shared cross-port contract
 * (`fixtures/conformance/api-docs-cross-port/expected-paths.json`) already declares — exactly as
 * the Java runner (`ApiDocsCrossPortConformanceTest`) asserts the `api/java` surface.
 *
 * **Why this test is deliberately RED.** Kotlin has no native SDK-docs surface yet — there is no
 * `KotlinApiModelBuilder`, and the `metaobjects:docs` Maven goal only emits `api/java`. The plan's
 * Phase 3 will build the Kotlin model + renderer and the `api/kotlin` Maven emit; this gate is the
 * pre-committed RED that proves the gap is enforced before the feature lands.
 *
 * **Why compile-safe (no reference to the not-yet-existing builder).** Referencing
 * `KotlinApiModelBuilder` from this test would fail `test-compile` and break EVERY Kotlin test in
 * the module — the wrong kind of red. Instead the test stays compile-clean and fails at RUNTIME,
 * and it is meaningfully tied to the contract first: it loads the SAME shared input metadata the
 * other ports load (proving the fixture loads under the Kotlin loader), then asserts the manifest
 * actually declares `apiKotlinSubDir = "api/kotlin"` and, per unit, the `apiKotlinPath` +
 * `apiKotlinToModel` fields and the exact back-link literal the rendered page must one day carry.
 * Only after those contract assertions hold does it [fail] — so the failure is "the Kotlin
 * `api/kotlin` surface is not implemented", not "the contract is missing". When Phase 3 lands the
 * builder, this test is rewritten to drive `KotlinApiModelBuilder` + the path math and the [fail]
 * is replaced with the real per-unit path/href/back-link assertions (mirroring the Java runner).
 *
 * If the contract assertions below ever fail, that is a REAL cross-port contract regression (the
 * shared manifest lost its `api/kotlin` declarations) — fix the manifest, not this gate.
 */
class ApiDocsCrossPortConformanceKtTest {

    private companion object {
        const val CASE = "api-docs-cross-port"
        val MAPPER = ObjectMapper()
    }

    /** Walk up to the repo root (the dir holding both `fixtures/` and `server/`). */
    private fun repoRoot(): Path {
        var p: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize()
        while (p != null) {
            if (Files.isDirectory(p.resolve("fixtures")) && Files.isDirectory(p.resolve("server"))) {
                return p
            }
            p = p.parent
        }
        throw IllegalStateException(
            "could not locate repo root (a dir containing both fixtures/ and server/) from user.dir",
        )
    }

    private fun caseDir(): Path = repoRoot().resolve("fixtures/conformance/$CASE")

    @Test
    fun `kotlin api-docs (api per kotlin) surface matches the shared manifest`() {
        // ---- load the shared contract + the SAME input metadata the other ports load ----
        val manifest: JsonNode =
            MAPPER.readTree(Files.readString(caseDir().resolve("expected-paths.json")))
        assertEquals("package", manifest.get("layout").asText(), "manifest layout must be 'package'")

        val apiKotlinSubDir = manifest.get("apiKotlinSubDir")?.asText()
        assertEquals(
            "api/kotlin",
            apiKotlinSubDir,
            "shared manifest must declare apiKotlinSubDir = 'api/kotlin' (the Kotlin cross-port " +
                "contract); if this fails the manifest regressed — fix the manifest, not this gate",
        )

        // Proves the shared fixture loads under the Kotlin loader (the input the Kotlin builder
        // will consume in Phase 3). Mirrors the Java runner loading the same input metadata.
        val metaJson = Files.readString(caseDir().resolve("input/meta.json"))
        val loader: MetaDataLoader = loadString("apiDocsCrossPort", metaJson)
        assertTrue(
            loader.children.isNotEmpty(),
            "shared api-docs-cross-port input metadata must load under the Kotlin loader",
        )

        // ---- per-unit: the contract carries the api/kotlin path + model back-href + the exact
        //      back-link literal the rendered Kotlin page must one day produce. Asserting these
        //      ties the gate to the contract so it is rewritten to real builder assertions in
        //      Phase 3 (it does NOT silently pass on a malformed manifest).
        val units = manifest.get("units")
        assertTrue(units != null && units.isArray && units.size() > 0, "manifest must list units")
        for (unitNode in units) {
            val node = unitNode.get("node").asText()

            val apiKotlinPath = unitNode.get("apiKotlinPath")?.asText()
            assertTrue(
                apiKotlinPath != null && apiKotlinPath.startsWith("$apiKotlinSubDir/"),
                "unit '$node' must declare an apiKotlinPath under '$apiKotlinSubDir/'; saw $apiKotlinPath",
            )

            val apiKotlinToModel = unitNode.get("apiKotlinToModel")?.asText()
            assertTrue(
                apiKotlinToModel != null && apiKotlinToModel.isNotBlank(),
                "unit '$node' must declare a non-blank apiKotlinToModel back-href; saw $apiKotlinToModel",
            )

            // The exact contract back-link literal a rendered api/kotlin page must carry — the
            // string the Phase-3 renderer assertion will check (kept here so the contract shape is
            // exercised even while the renderer does not exist yet).
            val expectedBackLink = "**Model / metadata:** [$node]($apiKotlinToModel)"
            assertTrue(
                expectedBackLink.contains(node) && expectedBackLink.contains(apiKotlinToModel),
                "back-link literal for '$node' must reference the node and its model href",
            )
        }

        // ---- the gap: no Kotlin native SDK-docs surface exists yet -------------------------------
        // There is no KotlinApiModelBuilder and the metaobjects:docs goal emits only api/java, so
        // the api/kotlin surface the manifest above demands cannot be produced. Fail RED here (NOT
        // a compile break — referencing the absent builder would break every Kotlin test). Phase 3
        // replaces this with real per-unit path/href/back-link assertions over KotlinApiModelBuilder.
        fail(
            "Kotlin native SDK docs (api/kotlin) not implemented — the shared manifest declares the " +
                "api/kotlin surface (asserted above) but no KotlinApiModelBuilder / api/kotlin emit " +
                "exists yet. See docs/superpowers/plans/2026-06-13-cross-port-sdk-docs.md Phase 3.",
        )
    }
}
