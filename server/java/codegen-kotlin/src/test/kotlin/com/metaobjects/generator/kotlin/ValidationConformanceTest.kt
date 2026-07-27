package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.registerKotlinModule
import com.metaobjects.metadata.ktx.loadString
import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import jakarta.validation.Validation
import jakarta.validation.Validator
import java.nio.file.Files
import java.nio.file.Path
import java.nio.charset.StandardCharsets
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * SP-C validator-parity gate — Kotlin port (Unit 5).
 *
 * Drives the shared behavioral corpus at `fixtures/validation-conformance/`:
 *  1. loads the corpus `meta.json` (the `Account` entity exercising every constraint:
 *     `@required` / `@maxLength`, `validator.length`, `validator.regex`,
 *     `validator.numeric`, `validator.array`),
 *  2. generates the `Account` Kotlin data class via [KotlinEntityGenerator] — which now
 *     carries `@field:`-site-targeted jakarta.validation constraints,
 *  3. COMPILES the generated source in-process (kotlin-compile-testing),
 *  4. for each corpus case: binds the case payload JSON onto the generated data class
 *     (jackson-module-kotlin constructor binding), validates it through a jakarta
 *     [Validator], and asserts `violations.isEmpty() == expectValid`.
 *
 * Single-source `expectValid` booleans — these MUST match the TS / C# / Python / Java
 * runners (the violates-only-X case design pins each constraint individually). A port
 * that fails to enforce constraint X wrongly accepts its violates-X payload → the case
 * fails here.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class ValidationConformanceTest {

    private fun repoRoot(): Path {
        var p: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (p != null && !Files.exists(p.resolve("fixtures/validation-conformance"))) {
            p = p.parent
        }
        assertTrue(p != null, "could not locate fixtures/validation-conformance from user.dir")
        return p!!
    }

    @Test fun `generated Account data class enforces the corpus verdicts`() {
        val corpus = repoRoot().resolve("fixtures/validation-conformance")
        val metaJson = String(Files.readAllBytes(corpus.resolve("meta.json")), StandardCharsets.UTF_8)

        val outDir = Files.createTempDirectory("validation-conf-")
        try {
            // --- generate the Account data class with jakarta.validation annotations ---
            val loader = loadString("validation-conformance", metaJson)
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loader)

            val accountKt = outDir.resolve("acme/auth/Account.kt")
            assertTrue(Files.exists(accountKt),
                "expected generated $accountKt; files=${Files.walk(outDir).toList()}")

            val src = accountKt.readText()
            // Sanity: the generated source must carry the jakarta constraints (a non-annotated
            // class would silently pass every case → false green).
            assertTrue("jakarta.validation.constraints" in src,
                "generated Account.kt must import jakarta.validation.constraints:\n$src")

            // --- compile the generated source in-process ---
            val emitted = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList()
            val sources = emitted.map { path ->
                SourceFile.kotlin(path.parent.relativize(path).toString().replace('/', '_'), path.readText())
            }
            val compileResult = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, compileResult.exitCode,
                "generated Account.kt failed to compile:\n${compileResult.messages}")

            // --- validate each corpus payload through a jakarta Validator ---
            val accountClass = compileResult.classLoader.loadClass("acme.auth.Account")
            val mapper = ObjectMapper().registerKotlinModule()
            val validator: Validator = Validation.buildDefaultValidatorFactory().validator

            val casesJson = String(Files.readAllBytes(corpus.resolve("cases.json")), StandardCharsets.UTF_8)
            val casesNode = mapper.readTree(casesJson).get("cases")
            assertTrue(casesNode != null && casesNode.size() > 0, "no cases in corpus")

            var checked = 0
            for (caseNode in casesNode) {
                val name = caseNode.get("name").asText()
                val expectValid = caseNode.get("expectValid").asBoolean()
                val payloadJson = caseNode.get("payload").toString()

                // Two boundary stages, exactly as a real Spring controller sees them:
                //   1. Jackson deserialization onto the generated data class. A missing
                //      *required* (non-nullable Kotlin) property cannot bind — that is a
                //      rejected request (valid=false), which is the same verdict jakarta's
                //      @NotNull would yield if the property were nullable.
                //   2. jakarta @Valid over the bound instance for every other constraint.
                val actualValid = try {
                    val dto = mapper.readValue(payloadJson, accountClass)
                    validator.validate(dto).isEmpty()
                } catch (ignored: com.fasterxml.jackson.core.JacksonException) {
                    // Missing/!nullable creator param, type mismatch, OR a #234 strict
                    // field.uri/field.inet deserializer rejecting a malformed literal → cannot
                    // bind → invalid request (HTTP 400), same verdict as TS safeParse / Python.
                    false
                } catch (ignored: IllegalArgumentException) {
                    // A deserializer's IllegalArgumentException that Jackson rethrew unwrapped.
                    false
                }

                assertEquals(expectValid, actualValid, "case '$name' verdict mismatch")
                checked++
            }
            assertEquals(casesNode.size(), checked, "every corpus case must be checked (no silent skip)")
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
