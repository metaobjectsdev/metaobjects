package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadDirectory
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * rc.21 — a string-stored `field.enum` with `@stringValueMap` on the Exposed table generator: a
 * VARCHAR `customEnumeration` mapping member <-> stored string in both directions, compiled
 * against the real Exposed API.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinExposedTableStringValueMapEnumTest {

    private val models: Path = run {
        var p: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (p != null && !Files.exists(p.resolve("src/test/resources/models"))) {
            p = p.parent
        }
        assertTrue(p != null, "could not locate src/test/resources/models from user.dir")
        p!!.resolve("src/test/resources/models")
    }

    private fun compile(outDir: Path): KotlinCompilation.Result {
        val sources = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            .map { path -> SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText()) }
        return KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
    }

    @Test fun `stringValueMap enum emits customEnumeration over VARCHAR and still compiles`() {
        val outDir = Files.createTempDirectory("ktbl-stored-enum-")
        try {
            val loader = loadDirectory("enum-string-value-map", models.resolve("enum-string-value-map"))
            for (gen in listOf(KotlinEntityGenerator(), KotlinExposedTableGenerator())) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }
            val src = outDir.resolve("acme/shop/UploadTable.kt").readText()
            assertTrue("customEnumeration(\"status\", \"VARCHAR(${KotlinTypeMapper.ENUM_VARCHAR_LEN})\"" in src,
                "status must use customEnumeration over VARCHAR; saw:\n$src")
            assertTrue("\"pending\" -> UploadStatus.Pending" in src && "UploadStatus.Delivered -> \"delivered\"" in src,
                "both lambdas must carry the stored strings; saw:\n$src")
            val result = compile(outDir)
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
