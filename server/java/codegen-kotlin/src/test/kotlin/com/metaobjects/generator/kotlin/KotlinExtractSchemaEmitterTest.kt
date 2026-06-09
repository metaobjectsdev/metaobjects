package com.metaobjects.generator.kotlin

import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Unit tests for the surviving shared helpers of [KotlinExtractSchemaEmitter].
 *
 * <p>The baked FieldSpec-literal emission (schemaLiteral / extractedClassDecl /
 * extractedCtorArgs) was removed in Move 1 — the only generated extract path is the
 * loader-delegating one, whose mirror declarations + mappers are exercised by
 * [KotlinNestedExtractLenientCompileRunTest] and [KotlinOutputParserGeneratorTest].
 * What remains testable in isolation here is the Kotlin string-escaping helper that
 * the surviving emitters (and [KotlinOutputFormatSpecEmitter]) all share.
 */
class KotlinExtractSchemaEmitterTest {

    @Test fun kotlinStringLiteralEscapesSpecialChars() {
        // Verify the escaping helper correctly handles backslash, quote, newline, tab, CR.
        val escaped = KotlinExtractSchemaEmitter.kotlinStringLiteral("a\\b\"c\nd\te\r")
        assertTrue("a\\\\b" in escaped, "backslash should be escaped; saw: $escaped")
        assertTrue("\\\"c"  in escaped, "double-quote should be escaped; saw: $escaped")
        assertTrue("\\n"    in escaped, "newline should be escaped; saw: $escaped")
        assertTrue("\\t"    in escaped, "tab should be escaped; saw: $escaped")
        assertTrue("\\r"    in escaped, "CR should be escaped; saw: $escaped")
    }

    @Test fun kotlinStringLiteralEscapesDollarSign() {
        // A bare $ in a string value must be emitted as \$ in the generated Kotlin source
        // to prevent string-template injection (e.g. "$amount" would cause an
        // unresolved-reference compile error in the consumer's generated code).
        val escaped = KotlinExtractSchemaEmitter.kotlinStringLiteral("cost is \$amount")
        assertTrue(
            "cost is \\\$amount" in escaped,
            "dollar sign must be escaped to \\$ in output; saw: $escaped"
        )
        // Also ensure the backslash before $ was NOT double-escaped (no \\\\$).
        assertTrue(
            "\\\\$" !in escaped,
            "dollar's backslash must not be double-escaped; saw: $escaped"
        )
    }
}
