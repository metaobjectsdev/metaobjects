package com.metaobjects.codegen.kotlin.apidocs

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.generator.kotlin.apidocs.ApiUnit
import com.metaobjects.generator.kotlin.apidocs.DocsPaths
import com.metaobjects.generator.kotlin.apidocs.KotlinApiDocsRenderer
import com.metaobjects.generator.kotlin.apidocs.KotlinApiModel
import com.metaobjects.generator.kotlin.apidocs.KotlinApiModelBuilder
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Cross-port api-docs LAYOUT conformance gate — the KOTLIN half (Phase 3, now GREEN).
 *
 * The Kotlin `api/kotlin` surface MUST resolve to the SAME paths + cross-link hrefs the shared
 * contract (`fixtures/conformance/api-docs-cross-port/expected-paths.json`) declares — exactly as
 * the Java runner (`ApiDocsCrossPortConformanceTest`) asserts the `api/java` surface and the TS
 * oracle asserts them all. Both ports asserting one manifest ⟹ the polyglot doc tree coheres:
 * a `model` page can link to every api surface, and each api page links back to the same model page,
 * with relative hrefs that resolve identically on disk.
 *
 * This loads the SAME input metadata the other ports load, builds the [KotlinApiModel] via
 * [KotlinApiModelBuilder], and for each manifest unit asserts — using the EXACT path/href math the
 * `metaobjects:docs` goal uses (computed via [DocsPaths], never re-derived here) — that:
 * - `apiKotlinSubDir + "/" + docPageOutputPath(PACKAGE, pkg, node)` equals the manifest `apiKotlinPath`;
 * - `modelCrossHref(apiKotlinPath, pagePath, null)` equals the manifest `apiKotlinToModel`;
 * - the rendered unit page actually carries the contract back-link
 *   `**Model / metadata:** [<node>](<modelHref>)`.
 *
 * It also asserts SET COVERAGE: the Kotlin builder documents exactly the manifest's unit set, so
 * neither port silently documents a different surface. A path/href divergence is a REAL cross-port
 * layout regression (or a Kotlin path bug) — the manifest is the single source of truth (already
 * validated by the TS test); fix the Kotlin side, do NOT weaken this gate.
 */
class ApiDocsCrossPortConformanceKtTest {

    private companion object {
        const val CASE = "api-docs-cross-port"
        const val PROJECT = "api-docs-cross-port"
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

        val metaJson = Files.readString(caseDir().resolve("input/meta.json"))
        val loader: MetaDataLoader = loadString("apiDocsCrossPort", metaJson)

        val model = KotlinApiModelBuilder().build(loader, PROJECT)

        // ---- coverage: the Kotlin builder documents the SAME unit set the manifest lists ----
        val manifestNodes = sortedSetOf<String>()
        for (u in manifest.get("units")) manifestNodes.add(u.get("node").asText())
        val kotlinNodes = sortedSetOf<String>()
        for (u in model.units) kotlinNodes.add(u.node)
        val missing = sortedSetOf<String>().apply { addAll(manifestNodes); removeAll(kotlinNodes) }
        assertTrue(
            missing.isEmpty(),
            "Kotlin api-docs does NOT document every unit the shared manifest lists.\n" +
                "  manifest units: $manifestNodes\n" +
                "  kotlin units  : $kotlinNodes\n" +
                "  MISSING from kotlin (in manifest, not documented): $missing\n" +
                "If Kotlin legitimately documents a different unit set, this is a real cross-port " +
                "finding — reconcile the manifest/builder together; do NOT weaken this assertion.",
        )
        assertEquals(
            manifestNodes, kotlinNodes,
            "Kotlin unit set must equal the shared manifest's unit set",
        )

        // ---- per-unit: api/kotlin path + model back-href match the manifest EXACTLY ----
        // Path/href math mirrors the docs Mojo with layout=package, apiSubDir="api/kotlin",
        // modelBaseUrl=null — every value from DocsPaths, nothing re-derived here.
        val renderer = KotlinApiDocsRenderer()
        val checked = mutableListOf<String>()
        for (unitNode in manifest.get("units")) {
            val node = unitNode.get("node").asText()
            val unit = findUnit(model, node)

            val pagePath = DocsPaths.docPageOutputPath(DocsPaths.Layout.PACKAGE, unit.pkg, unit.node)

            val apiKotlinPath = "$apiKotlinSubDir/$pagePath"
            assertEquals(
                unitNode.get("apiKotlinPath").asText(), apiKotlinPath,
                "api/kotlin path for '$node' must match the shared manifest",
            )

            val modelHref = DocsPaths.modelCrossHref(apiKotlinPath, pagePath, null)
            assertEquals(
                unitNode.get("apiKotlinToModel").asText(), modelHref,
                "api/kotlin → model href for '$node' must match the shared manifest",
            )

            // The rendered page must actually carry the contract back-link.
            val page = renderer.renderUnitPage(unit, modelHref)
            val expectedBackLink = "**Model / metadata:** [$node]($modelHref)"
            assertTrue(
                page.contains(expectedBackLink),
                "rendered api/kotlin page for '$node' must carry the back-link:\n  " +
                    "$expectedBackLink\nactual page:\n$page",
            )

            checked.add(node)
        }

        // Guard: every manifest unit was actually asserted (no silent zero-iteration pass).
        assertEquals(
            manifestNodes, sortedSetOf<String>().apply { addAll(checked) },
            "must have asserted every manifest unit",
        )
    }

    private fun findUnit(model: KotlinApiModel, node: String): ApiUnit =
        model.units.firstOrNull { it.node == node }
            ?: throw AssertionError("no Kotlin api-docs unit '$node' in ${model.units}")
}
