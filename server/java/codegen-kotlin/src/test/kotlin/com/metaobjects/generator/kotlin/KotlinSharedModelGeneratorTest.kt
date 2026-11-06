package com.metaobjects.generator.kotlin

import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.registry.RegistryManifest
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * FR-023 publish — Kotlin inherits the artifact engine and the Maven goals from the Java port; what
 * it owns is its generator class. One corpus case (`fixtures/shared-model-conformance`) goes through
 * the class the registry hands out, with the project version supplied the way the Maven plugin does,
 * and the two files must equal the pinned bytes.
 */
class KotlinSharedModelGeneratorTest {

    private fun corpus(): Path {
        var dir: Path? = Paths.get("").toAbsolutePath()
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.parent
        return dir!!.resolve("fixtures/shared-model-conformance")
    }

    @Test fun `the registered shared-model generator writes the bytes the corpus pins`() {
        val out = Files.createTempDirectory("kshared-out-")
        try {
            val gen = GENERATOR_REGISTRY.getValue("shared-model").factory()
            gen.setArgs(
                mapOf(
                    "outputDir" to out.toString(),
                    "version" to "1.0.0",
                    "name" to "acme-common",
                    "include" to "acme::common::**",
                    "exclude" to "acme::common::Secret",
                    "files" to "${corpus().resolve("source/meta.base.json")},${corpus().resolve("source/meta.customer.json")}",
                ),
            )
            val loader = MetaDataLoader(LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "kshared")
            loader.init()
            gen.execute(loader)

            assertEquals(
                Files.readString(corpus().resolve("../dependency-conformance/artifacts/acme-common-v1.json").normalize()),
                Files.readString(out.resolve("acme-common.metaobjects.json")),
            )
            assertEquals(
                Files.readString(corpus().resolve("expected/acme-common-v1/metaobjects.pkg.json"))
                    .replace("@@METAMODEL_VERSION@@", RegistryManifest.METAMODEL_VERSION),
                Files.readString(out.resolve("metaobjects.pkg.json")),
            )
            assertTrue(Files.list(out).use { it.count() } == 2L, "exactly the artifact and the manifest")
        } finally {
            out.toFile().deleteRecursively()
        }
    }
}
