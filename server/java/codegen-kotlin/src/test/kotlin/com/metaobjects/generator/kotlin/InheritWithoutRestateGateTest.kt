package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * GATE / TRIPWIRE for issue #56 — Kotlin codegen must read INHERITED field attributes via
 * the effective accessor, not own-only. This test asserts the CORRECT behavior and is RED
 * until #56 is fixed: a `field.string` that inherits `@maxLength` via `extends`
 * (abstract-field reuse) without restating it must emit `varchar("...", <inherited>)`, but
 * `KotlinTypeMapper` reads `@maxLength` own-only → falls back to the 255 default. See #56.
 */
class InheritWithoutRestateGateTest {

    private val fixture = """{
      "metadata.root": { "package": "test", "children": [
        { "object.entity": { "name": "Base", "abstract": true, "children": [
            { "field.string": { "name": "baseLabel", "@maxLength": 80, "@required": true } }
        ] } },
        { "object.entity": { "name": "Widget", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "label", "extends": "test::Base.baseLabel" } },
            { "source.rdb":   { "@table": "widgets" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test
    fun `inherited maxLength emits the inherited varchar length, not the 255 default`() {
        val outDir = Files.createTempDirectory("ktgate-")
        try {
            val gen = KotlinExposedTableGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test", fixture))

            val src = Files.readString(outDir.resolve("test/WidgetTable.kt"))
            // RED until #56 is fixed: inherited @maxLength=80 should win, not the 255 fallback.
            assertTrue("varchar(\"label\", 80)" in src,
                "expected inherited @maxLength=80 on the label column, got:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
