package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KotlinSpringConfigGeneratorTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name" } },
            { "source.rdb":   { "@table": "authors" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `emitsConfigurationClassWithDatasourceCtor`() {
        val outDir = Files.createTempDirectory("kspr-")
        try {
            val gen = KotlinSpringConfigGenerator()
            gen.setArgs(mapOf(
                "outputDir" to outDir.toString(),
                "packageName" to "acme.demo"
            ))
            gen.execute(loadString("test", fixture))

            val file = outDir.resolve("acme/demo/MetadataExposedConfig.kt")
            assertTrue(Files.exists(file),
                "expected $file; files=${Files.walk(outDir).toList()}")

            val src = Files.readString(file)
            assertTrue("package acme.demo" in src, src)
            assertTrue("@Configuration" in src, src)
            assertTrue("class MetadataExposedConfig" in src, src)
            assertTrue("dataSource: DataSource" in src, src)
            assertTrue("import javax.sql.DataSource" in src, src)
            assertTrue("import org.jetbrains.exposed.sql.Database" in src, src)
            assertTrue("Database.connect(dataSource)" in src, src)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `emitsValidatorEventListenerByDefault`() {
        val outDir = Files.createTempDirectory("kspr-")
        try {
            val gen = KotlinSpringConfigGenerator()
            gen.setArgs(mapOf(
                "outputDir" to outDir.toString(),
                "packageName" to "acme.demo",
                "metadataResource" to "meta.entities.json,meta.common.json"
            ))
            gen.execute(loadString("test", fixture))

            val file = outDir.resolve("acme/demo/MetadataExposedConfig.kt")
            val src = Files.readString(file)
            assertTrue("@EventListener(ApplicationReadyEvent::class)" in src, src)
            assertTrue("fun validateMetadata()" in src, src)
            assertTrue("MetadataStartupValidator.validate(loader)" in src, src)
            assertTrue("\"meta.entities.json\"" in src, src)
            assertTrue("\"meta.common.json\"" in src, src)
            assertTrue("import org.springframework.context.event.EventListener" in src, src)
            assertTrue(
                "import org.springframework.boot.context.event.ApplicationReadyEvent" in src,
                src
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `validatorEnabledFalseSkipsEventListener`() {
        val outDir = Files.createTempDirectory("kspr-")
        try {
            val gen = KotlinSpringConfigGenerator()
            gen.setArgs(mapOf(
                "outputDir" to outDir.toString(),
                "packageName" to "acme.demo",
                "validatorEnabled" to "false"
            ))
            gen.execute(loadString("test", fixture))

            val file = outDir.resolve("acme/demo/MetadataExposedConfig.kt")
            val src = Files.readString(file)
            assertTrue("Database.connect(dataSource)" in src, src)
            assertFalse("@EventListener" in src, "expected no @EventListener in:\n$src")
            assertFalse("validateMetadata" in src, "expected no validateMetadata in:\n$src")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
