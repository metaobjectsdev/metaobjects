package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals

@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinOutputCompilesTest {

    private val fixture = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Author", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "name", "@maxLength": 100, "@required": true } }
        ] } }
      ] }
    }""".trimIndent()

    @Test fun `generated Author kt compiles`() {
        val outDir = Files.createTempDirectory("compile-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loadString("test", fixture))

            val sources = Files.walk(outDir).filter { it.isRegularFile() }
                .map { SourceFile.kotlin(it.fileName.toString(), it.readText()) }
                .toList()

            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true   // include kotlinx.serialization-runtime + Exposed if on the test classpath
                messageOutputStream = System.out
            }.compile()

            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated Kotlin failed to compile:\n${result.messages}")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
