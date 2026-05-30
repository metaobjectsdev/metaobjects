package com.metaobjects.generator.kotlin

import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Cross-port conformance for the "never emit instance/write artifacts for an abstract
 * entity" invariant, exercised against the shared codegen-conformance abstract fixture.
 *
 * Fixture (`fixtures/codegen-conformance/abstract/input/meta.abstract.json`, package
 * `acme::shop`):
 *  - `AbstractRecord` — abstract, HAS a `source.rdb` → write generators must suppress it.
 *  - `BaseShape`      — abstract, NO source → already skipped, must stay suppressed.
 *  - `Widget`         — concrete, extends BaseShape, HAS a `source.rdb` → must emit.
 */
class KotlinAbstractConformanceTest {

    private fun loadFixture(): MetaDataLoader {
        val fixturePath = Path.of(System.getProperty("user.dir"))
            .resolve("../../..").normalize()
            .resolve("fixtures/codegen-conformance/abstract/input/meta.abstract.json")
        assertTrue(Files.exists(fixturePath), "shared fixture missing at $fixturePath")
        val text = Files.readString(fixturePath)
        return loadString("abstractFixture", text)
    }

    private fun tempDir() = Files.createTempDirectory("kgen-abstract-conf-")

    @Test fun `exposed table generator suppresses abstract entity with a source`() {
        val loader = loadFixture()
        val outDir = tempDir()
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loader)

            val abstractTable = outDir.resolve("acme/shop/AbstractRecordTable.kt")
            val widgetTable = outDir.resolve("acme/shop/WidgetTable.kt")
            assertFalse(Files.exists(abstractTable),
                "AbstractRecordTable.kt MUST NOT be emitted for an abstract entity; " +
                    "files=${Files.walk(outDir).toList()}")
            assertTrue(Files.exists(widgetTable),
                "WidgetTable.kt SHOULD be emitted for the concrete Widget; " +
                    "files=${Files.walk(outDir).toList()}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `spring controller generator suppresses abstract entity with a source`() {
        val loader = loadFixture()
        val outDir = tempDir()
        try {
            val gen = KotlinSpringControllerGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loader)

            val abstractCtrl = outDir.resolve("acme/shop/AbstractRecordController.kt")
            val widgetCtrl = outDir.resolve("acme/shop/WidgetController.kt")
            assertFalse(Files.exists(abstractCtrl),
                "AbstractRecordController.kt MUST NOT be emitted; files=${Files.walk(outDir).toList()}")
            assertTrue(Files.exists(widgetCtrl),
                "WidgetController.kt SHOULD be emitted; files=${Files.walk(outDir).toList()}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `entity generator omits abstract shapes by default`() {
        val loader = loadFixture()
        val outDir = tempDir()
        try {
            val gen = KotlinEntityGenerator()
            // emitAbstractShapes defaults to false; assert it explicitly too.
            gen.setArgs(mapOf("outputDir" to outDir.toString(), "emitAbstractShapes" to "false"))
            gen.execute(loader)

            assertFalse(Files.exists(outDir.resolve("acme/shop/AbstractRecord.kt")),
                "AbstractRecord.kt MUST NOT be emitted with emitAbstractShapes=false; " +
                    "files=${Files.walk(outDir).toList()}")
            assertFalse(Files.exists(outDir.resolve("acme/shop/BaseShape.kt")),
                "BaseShape.kt MUST NOT be emitted with emitAbstractShapes=false; " +
                    "files=${Files.walk(outDir).toList()}")
            assertTrue(Files.exists(outDir.resolve("acme/shop/Widget.kt")),
                "Widget.kt SHOULD be emitted (concrete); files=${Files.walk(outDir).toList()}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `entity generator emits abstract interface shape when enabled`() {
        val loader = loadFixture()
        val outDir = tempDir()
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString(), "emitAbstractShapes" to "true"))
            gen.execute(loader)

            val abstractKt = outDir.resolve("acme/shop/AbstractRecord.kt")
            assertTrue(Files.exists(abstractKt),
                "AbstractRecord.kt SHOULD be emitted with emitAbstractShapes=true; " +
                    "files=${Files.walk(outDir).toList()}")
            val src = Files.readString(abstractKt)
            assertTrue("interface AbstractRecord" in src,
                "expected an `interface AbstractRecord` shape; saw:\n$src")
            // A source-less abstract (BaseShape) is also a scaffolding shape: it should still get
            // an interface in ON mode, mirroring the OFF-mode test that asserts it is absent.
            assertTrue(Files.exists(outDir.resolve("acme/shop/BaseShape.kt")),
                "BaseShape.kt SHOULD be emitted as an interface shape with emitAbstractShapes=true " +
                    "(abstract, no source); files=${Files.walk(outDir).toList()}")
            assertTrue(Files.exists(outDir.resolve("acme/shop/Widget.kt")),
                "Widget.kt SHOULD still be emitted (concrete); files=${Files.walk(outDir).toList()}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `validator registry excludes abstract entities`() {
        val loader = loadFixture()
        val outDir = tempDir()
        try {
            val gen = KotlinValidatorGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString(), "packageName" to "acme.shop"))
            gen.execute(loader)

            // The validator emits one registry file referencing each entity's *Table.
            val files = outDir.toFile().walkTopDown().filter { it.extension == "kt" }.toList()
            val combined = files.joinToString("\n") { it.readText() }
            assertTrue("WidgetTable" in combined,
                "validator registry should reference WidgetTable; saw:\n$combined")
            assertFalse("AbstractRecordTable" in combined,
                "validator registry MUST NOT reference an abstract entity's table; saw:\n$combined")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
