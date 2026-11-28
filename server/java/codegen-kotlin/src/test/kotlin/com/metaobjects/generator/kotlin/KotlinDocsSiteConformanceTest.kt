package com.metaobjects.generator.kotlin

import com.metaobjects.docsview.DocsViewConformanceTest
import com.metaobjects.generator.DocsSiteGenerator
import com.metaobjects.generator.GeneratorBase
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The Kotlin port's `docs-site`, run through this port's registry, writes every
 * `fixtures/explorer-conformance/` case's `explorer.json` byte for byte, as TypeScript and Java do.
 */
class KotlinDocsSiteConformanceTest {

    @Test
    fun `docs-site writes every explorer-conformance case byte for byte`(@TempDir tmp: Path) {
        val info = getGenerator("docs-site") ?: error("docs-site is not in the Kotlin registry")
        assertEquals(null, info.ejectResourcePath, "docs-site is eject-exempt")
        for (name in DocsViewConformanceTest.fixtures()) {
            val dir = DocsViewConformanceTest.corpus().resolve(name)
            val work = tmp.resolve(name)
            val genState = Files.createDirectories(work.resolve("gen-state"))
            if (Files.isRegularFile(dir.resolve("hashes.json"))) Files.copy(dir.resolve("hashes.json"), genState.resolve(".hashes.json"))
            val args = mutableMapOf(
                GeneratorBase.ARG_OUTPUTDIR to work.resolve("out").toString(),
                DocsSiteGenerator.ARG_PROJECT_ROOT to dir.resolve("project").toString(),
                DocsSiteGenerator.ARG_GEN_STATE_DIR to genState.toString(),
            )
            if (Files.isRegularFile(dir.resolve("verify.json"))) args[DocsSiteGenerator.ARG_VERIFY_FILE] = dir.resolve("verify.json").toString()
            if (Files.isRegularFile(dir.resolve("routes.json"))) args[DocsSiteGenerator.ARG_ROUTES_FILE] = dir.resolve("routes.json").toString()
            val generator = info.factory()
            generator.setArgs(args)
            generator.execute(DocsViewConformanceTest.load(name))
            assertEquals(
                Files.readString(dir.resolve("expected.json")),
                Files.readString(work.resolve("out/site/explorer.json")),
                name,
            )
            for (f in listOf("index.html", "assets/explorer-app.js", "explorer-model.js", "explorer-stamp.js")) {
                assertTrue(Files.isRegularFile(work.resolve("out/site").resolve(f)), "$name: $f")
            }
        }
    }
}
