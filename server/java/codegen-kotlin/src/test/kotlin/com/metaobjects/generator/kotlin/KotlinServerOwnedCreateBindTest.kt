package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import jakarta.validation.Validation
import java.nio.file.Files
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * A `@required @mutability: readOnly` field must not make an entity UNCREATABLE (1.2.x):
 * the create SECURITY skip drops the column from the insert, so the request-body data
 * class must not demand the value either — nullable, default-null, no `@field:NotNull` —
 * the same relaxation the generated key and `@autoSet` already get. The cross-port
 * contract is `docs/features/generated-mutations.md` "Create stores only what a client
 * may set": a body omitting a server-owned field is CORRECT, never a 400.
 *
 * Executes the two boundary stages a real Spring create runs, exactly as
 * [ValidationConformanceTest] does: Jackson (jackson-module-kotlin, constructor binding)
 * deserialization of the body onto the COMPILED generated data class, then the jakarta
 * Validator over the bound instance. The insert-side drop (client value never stored) is
 * gated by the api-contract `input-server-owned-dropped` scenarios. Oracle: the cross-port
 * rule above; the wrong behavior rejected is the pre-fix 400 — a missing non-null creator
 * parameter with no default, or a `@NotNull` violation on the omitted value.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinServerOwnedCreateBindTest {

    private val model = """{
      "metadata.root": { "package": "acme::bind", "children": [
        { "object.entity": { "name": "Doc", "children": [
            { "source.rdb":   { "@table": "docs" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "title", "@required": true, "@maxLength": 100 } },
            { "field.string": { "name": "role", "@required": true, "@maxLength": 20, "@mutability": "readOnly" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    @Test
    fun `create body binds and validates with the readOnly field omitted and present`() {
        val out = Files.createTempDirectory("kowned-bind-")
        try {
            val loader = loadString("owned-bind", model)
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to out.toString())) }.execute(loader)

            val sources = Files.walk(out).filter { it.isRegularFile() }.sorted().toList()
                .map { path -> SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText()) }
            val compileResult = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, compileResult.exitCode,
                "generated Doc.kt failed to compile:\n${compileResult.messages}")

            val docClass = compileResult.classLoader.loadClass("acme.bind.Doc")
            val mapper = ObjectMapper().registerKotlinModule()
            val validator = Validation.buildDefaultValidatorFactory().validator

            // Omitted: pre-fix this cannot bind (non-null creator param, no default) → 400.
            val omitted = mapper.readValue("""{"title":"t"}""", docClass)
            assertTrue(validator.validate(omitted).isEmpty(), "omitted readOnly field must not be demanded")

            // Present: binds (client value never reaches the insert — api-contract scenario)
            // and validates; pre-fix the column skip then hit the NOT NULL column → 500.
            val present = mapper.readValue("""{"title":"t","role":"evil"}""", docClass)
            assertTrue(validator.validate(present).isEmpty(), "present readOnly value must not be rejected")

            // The omitted binding relaxed the property: nullable, defaulted to null.
            assertNull(docClass.getMethod("getRole").invoke(omitted))
        } finally {
            out.toFile().deleteRecursively()
        }
    }
}
