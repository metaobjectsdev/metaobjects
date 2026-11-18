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

/**
 * Entity-scoped cross-field validators on the generated data class, beyond the shared corpus
 * (`ValidationConformanceTest` runs that): a rule naming a field the entity lacks is skipped
 * while the class still compiles and validates, and rules over long field names — whose
 * rendered getter is wide enough for KotlinPoet to wrap, and Kotlin rejects a line break before
 * a comparison operator — still compile and give the right verdict. Field-name lengths step
 * through a range so some entity's getter wraps right at an operator. Oracle: the validators'
 * declared meaning, e.g. `lte` rejects 3 > 1.
 */
@OptIn(org.jetbrains.kotlin.compiler.plugin.ExperimentalCompilerApi::class)
class KotlinCrossFieldValidationTest {

    private val widths = 0..15

    private fun entity(i: Int): String {
        val pad = "x".repeat(i)
        val start = "scheduledStartTimeInMinutes$pad"
        val end = "scheduledEndTimeInMinutes"
        val category = "cancellationReasonCategory$pad"
        val note = "cancellationReasonDescription"
        val moved = "rescheduledAppointmentReference"
        return """
            { "object.entity": { "name": "Appointment$i", "children": [
              { "source.rdb":   { "@table": "appointments$i" } },
              { "field.long":   { "name": "id" } },
              { "field.int":    { "name": "$start" } },
              { "field.int":    { "name": "$end" } },
              { "field.string": { "name": "$category" } },
              { "field.string": { "name": "$note" } },
              { "field.string": { "name": "$moved" } },
              { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
              { "validator.comparison":   { "name": "startsBeforeEnds", "@left": "$start", "@op": "lte", "@right": "$end" } },
              { "validator.requiredWhen": { "name": "cancelNeedsDescription", "@field": "$note", "@when": "$category", "@equals": "CANCELLED_BY_PATIENT" } },
              { "validator.presentIff":   { "name": "rescheduledIffMoved", "@field": "$moved", "@when": "$category", "@equals": "RESCHEDULED_BY_CLINIC" } },
              { "validator.requiredWhen": { "name": "ghost", "@field": "nope", "@when": "$category", "@equals": "X" } }
            ]}}"""
    }

    private val model = """{ "metadata.root": { "package": "acme::ev", "children": [
        ${widths.joinToString(",") { entity(it) }}
    ]}}"""

    @Test fun `long-named rules compile and are enforced, and a rule on a missing field is skipped`() {
        val outDir = Files.createTempDirectory("kt-crossfield-")
        try {
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }
                .execute(loadString("ev", model))
            val sources = Files.walk(outDir).filter { it.isRegularFile() }.sorted().toList().map {
                SourceFile.kotlin(it.parent.relativize(it).toString().replace('/', '_'), it.readText())
            }
            val result = KotlinCompilation().apply {
                this.sources = sources
                inheritClassPath = true
                messageOutputStream = System.out
            }.compile()
            assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode,
                "generated entities failed to compile:\n${result.messages}")

            val mapper = ObjectMapper().registerKotlinModule()
            val validator = Validation.buildDefaultValidatorFactory().validator
            for (i in widths) {
                val pad = "x".repeat(i)
                fun violations(start: Int, category: String, extra: String = ""): Int {
                    val json = """{"scheduledStartTimeInMinutes$pad":$start,"scheduledEndTimeInMinutes":3,""" +
                        """"cancellationReasonCategory$pad":"$category"$extra}"""
                    val dto = mapper.readValue(json, result.classLoader.loadClass("acme.ev.Appointment$i"))
                    return validator.validate(dto).size
                }
                assertEquals(0, violations(1, "OTHER"), "width $i: valid body")
                assertEquals(1, violations(5, "OTHER"), "width $i: comparison")
                assertEquals(1, violations(1, "CANCELLED_BY_PATIENT"), "width $i: requiredWhen")
                assertEquals(1, violations(1, "RESCHEDULED_BY_CLINIC"), "width $i: presentIff")
                assertEquals(0, violations(1, "RESCHEDULED_BY_CLINIC", ""","rescheduledAppointmentReference":"r""""),
                    "width $i: presentIff satisfied")
            }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
