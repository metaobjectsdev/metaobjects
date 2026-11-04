package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Entity-scoped cross-field validators render as `@get:AssertTrue @get:JsonIgnore` body
 * properties on the entity data class (not in the constructor). Behavior is gated by
 * [ValidationConformanceTest] against the shared corpus.
 */
class KotlinCrossFieldValidationTest {

    private fun model(withValidators: Boolean): String {
        val validators = if (withValidators) """
            , { "validator.comparison":   { "name": "startsBeforeEnds", "@left": "startsAt", "@op": "lte", "@right": "endsAt" } },
              { "validator.requiredWhen": { "name": "birthNeedsSubject", "@field": "subject", "@when": "kind", "@equals": "BIRTH" } },
              { "validator.presentIff":   { "name": "closedIffNote", "@field": "note", "@when": "kind", "@equals": "CLOSED" } },
              { "validator.atLeastOne":   { "name": "reachable", "@fields": ["subject", "note"] } },
              { "validator.requiredWhen": { "name": "ghost", "@field": "nope", "@when": "kind", "@equals": "X" } }
        """ else ""
        return """
            { "metadata.root": { "package": "acme::ev", "children": [
              { "object.entity": { "name": "Ev", "children": [
                { "source.rdb":   { "@table": "evs" } },
                { "field.long":   { "name": "id" } },
                { "field.int":    { "name": "startsAt" } },
                { "field.int":    { "name": "endsAt" } },
                { "field.string": { "name": "kind" } },
                { "field.string": { "name": "subject" } },
                { "field.string": { "name": "note" } },
                { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
                $validators
              ]}}
            ]}}
        """
    }

    private fun gen(withValidators: Boolean): String {
        val out = Files.createTempDirectory("kt-crossfield-")
        try {
            val gen = KotlinEntityGenerator()
            gen.setArgs(mapOf("outputDir" to out.toString()))
            gen.execute(loadString("ev", model(withValidators)))
            return out.resolve("acme/ev/Ev.kt").readText()
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test fun `data class carries one AssertTrue per validator and skips unresolvable ones`() {
        val src = gen(true)
        for (m in listOf("isStartsBeforeEndsValid", "isBirthNeedsSubjectValid", "isClosedIffNoteValid", "isReachableValid")) {
            assertTrue("val $m: Boolean" in src, "$m missing:\n$src")
        }
        assertFalse("isGhostValid" in src, "validator naming a missing field is skipped:\n$src")
        assertTrue("@get:JsonIgnore" in src && "@get:AssertTrue" in src, src)
    }

    @Test fun `entity without cross-field validators emits no AssertTrue`() {
        assertFalse("AssertTrue" in gen(false))
    }
}
