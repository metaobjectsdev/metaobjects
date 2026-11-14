package com.metaobjects.generator.kotlin

import com.tschuchort.compiletesting.KotlinCompilation
import com.tschuchort.compiletesting.SourceFile
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The generated `MetaValidationIssues` and `MetaDecimalWire.unreadableBody`, compiled and run: the Zod-style code
 * for each constraint, every violation listed with its path, and a binding failure classified.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinValidationIssuesTest {

    private val harness = """
        package acme.probe

        import jakarta.validation.Validation
        import jakarta.validation.constraints.DecimalMax
        import jakarta.validation.constraints.Digits
        import jakarta.validation.constraints.Max
        import jakarta.validation.constraints.Min
        import jakarta.validation.constraints.NotNull
        import jakarta.validation.constraints.Pattern
        import jakarta.validation.constraints.Size
        import jakarta.validation.Valid
        import com.fasterxml.jackson.databind.ObjectMapper
        import java.math.BigDecimal

        class Marker(@field:NotNull val label: String?)
        class Bean(
            @field:NotNull val required: String?,
            @field:Size(min = 2, max = 4) val sized: String?,
            @field:Max(5) val big: Int?,
            @field:Min(5) val small: Int?,
            @field:DecimalMax("1.5") val decBig: BigDecimal?,
            @field:Digits(integer = 2, fraction = 1) val digits: BigDecimal?,
            @field:Pattern(regexp = "[a-z]+") val pattern: String?,
            @field:Valid val markers: List<Marker>?,
        )
        class Holder { var n: Int? = null }

        object Probe {
            @JvmStatic fun codes(): Map<String, String> {
                val v = Validation.buildDefaultValidatorFactory().validator
                val bean = Bean(null, "toolong", 9, 1, BigDecimal("2"), BigDecimal("123.45"), "NOPE", listOf(Marker("ok"), Marker(null)))
                val body = MetaValidationIssues.Collector().addViolations(v.validate(bean)).body()
                return (body["issues"] as List<*>).associate { (it as Map<*, *>)["path"].toString() to it["code"] as String }
            }
            @JvmStatic fun sizeBelowMin(): String {
                val v = Validation.buildDefaultValidatorFactory().validator
                val bean = Bean("x", "a", null, null, null, null, null, null)
                return MetaValidationIssues.codeOf(v.validate(bean).single())
            }
            @JvmStatic fun unreadable(): Map<String, Any> =
                try { ObjectMapper().readValue("{\"n\": \"abc\"}", Holder::class.java); emptyMap() }
                catch (e: Exception) { MetaDecimalWire.unreadableBody(e) }
        }
    """.trimIndent()

    @Test
    fun `every violation is listed with its Zod code and nested path, and a bind failure is classified`() {
        val sources = listOf(
            SourceFile.kotlin("MetaDecimalWire.kt", "package acme.probe\n\n" + KotlinDecimalWireEmitter.BODY),
            SourceFile.kotlin("MetaValidationIssues.kt", "package acme.probe\n\n" + KotlinValidationIssuesEmitter.BODY),
            SourceFile.kotlin("Probe.kt", harness),
        )
        val result = KotlinCompilation().apply {
            this.sources = sources
            inheritClassPath = true
            messageOutputStream = System.out
        }.compile()
        assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
        val probe = result.classLoader.loadClass("acme.probe.Probe")
        @Suppress("UNCHECKED_CAST")
        val codes = probe.getMethod("codes").invoke(null) as Map<String, String>
        assertEquals("invalid_type", codes["[required]"])
        assertEquals("too_big", codes["[sized]"])
        assertEquals("too_big", codes["[big]"])
        assertEquals("too_small", codes["[small]"])
        assertEquals("too_big", codes["[decBig]"])
        assertEquals("too_big", codes["[digits]"])
        assertEquals("invalid_format", codes["[pattern]"])
        assertEquals("invalid_type", codes["[markers, 1, label]"])
        assertEquals(8, codes.size)
        assertEquals("too_small", probe.getMethod("sizeBelowMin").invoke(null))
        @Suppress("UNCHECKED_CAST")
        val body = probe.getMethod("unreadable").invoke(null) as Map<String, Any>
        assertEquals("validation", body["error"])
        assertEquals("n", body["field"])
        val issue = (body["issues"] as List<*>).single() as Map<*, *>
        assertEquals(listOf("n"), issue["path"])
        assertEquals("invalid_type", issue["code"])
    }
}
