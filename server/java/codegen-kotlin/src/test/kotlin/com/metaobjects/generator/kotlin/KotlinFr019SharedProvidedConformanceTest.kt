package com.metaobjects.generator.kotlin

import com.fasterxml.jackson.databind.ObjectMapper
import com.metaobjects.field.EnumField
import com.metaobjects.field.MetaField
import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.`object`.MetaObject
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.readText
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Cross-port FR-019 conformance (Kotlin). Loads the shared fixture
 * `fixtures/codegen-conformance/shared-provided-enum/input/meta.json` and asserts the two FR-019
 * behaviors (ADR-0026):
 *  - Shared materialization — a package-level abstract `field.enum` (`Priority`) extended by TWO
 *    entities is materialized ONCE as a standalone `enum class Priority`; both data classes type
 *    their property as it (no per-entity redeclaration).
 *  - `@provided` — a package-level abstract `field.enum` (`Currency`, `@provided: true`) is NOT
 *    materialized; consuming data classes reference it at the configured namespace
 *    (`<ns>.Currency`). A referenced provided enum with no configured namespace is a codegen-time
 *    error naming the enum.
 */
class KotlinFr019SharedProvidedConformanceTest {

    private fun loadFixture(): MetaDataLoader {
        val fixture = Path.of(System.getProperty("user.dir"))
            .resolve("../../..").normalize()
            .resolve("fixtures/codegen-conformance/shared-provided-enum/input/meta.json")
        assertTrue(Files.exists(fixture), "shared FR-019 fixture missing at $fixture")
        return loadString("sharedProvidedEnumFixture", Files.readString(fixture))
    }

    private fun generate(providedEnumNamespace: String?): Path {
        val out = Files.createTempDirectory("kgen-fr019-conf-")
        val args = mutableMapOf("outputDir" to out.toString())
        if (providedEnumNamespace != null) args["providedEnumNamespace"] = providedEnumNamespace
        KotlinEntityGenerator().apply { setArgs(args) }.execute(loadFixture())
        return out
    }

    @Test
    fun `shared enum is materialized once and referenced by both entities`() {
        val out = generate("com.acme.ext")
        try {
            val priorityEnum = out.resolve("acme/shop/Priority.kt")
            assertTrue(Files.exists(priorityEnum), "shared Priority.kt enum class must be materialized")
            val enumSrc = priorityEnum.readText()
            assertTrue("enum class Priority" in enumSrc, "expected shared `enum class Priority`; saw:\n$enumSrc")
            for (m in listOf("LOW", "MEDIUM", "HIGH"))
                assertTrue(m in enumSrc, "member $m must be present; saw:\n$enumSrc")

            for (name in listOf("Ticket.kt", "Order.kt")) {
                val dc = out.resolve("acme/shop").resolve(name)
                assertTrue(Files.exists(dc), "$name must be emitted")
                val src = dc.readText()
                assertTrue("priority" in src && "Priority" in src,
                    "$name must type its priority property as the shared enum; saw:\n$src")
                // Same-package reference: no redeclaration and no cross-package import.
                assertFalse("enum class Priority" in src, "$name must NOT redeclare the shared enum; saw:\n$src")
            }
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `provided enum is not materialized and referenced at the configured namespace`() {
        val out = generate("com.acme.ext")
        try {
            assertFalse(Files.exists(out.resolve("acme/shop/Currency.kt")),
                "provided Currency must NOT be materialized")
            val ticket = out.resolve("acme/shop/Ticket.kt").readText()
            assertTrue("com.acme.ext.Currency" in ticket || "import com.acme.ext.Currency" in ticket,
                "currency property must reference the configured external namespace; saw:\n$ticket")
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    /**
     * A CHAINED declaration: root abstract `Money extends` root abstract `@provided Currency`.
     *
     * Per ADR-0026 §2 a materialized type is named for ITS OWN declaration, and ADR-0039 makes
     * `@provided` declaration-layer (it does not flow down the chain), so `Money` is its own type,
     * materialized from the members it inherits. #246 guarantees the chain can rename the
     * vocabulary but never mutate it.
     *
     * Kotlin used to name a chained enum after the TOP-MOST root while its FR-019 arm decided
     * materialize-vs-reference from the IMMEDIATE super — so it emitted a local `Currency.kt`
     * that collided with the `com.acme.ext.Currency` reference asserted above. All five ports
     * must agree here.
     */
    @Test
    fun `chained abstract enum is materialized under its OWN name, not the roots`() {
        val out = generate("com.acme.ext")
        try {
            val money = out.resolve("acme/shop/Money.kt")
            assertTrue(Files.exists(money), "chained Money must be materialized under its own name")
            val src = money.readText()
            for (member in listOf("USD", "EUR", "GBP")) {
                assertTrue(member in src, "Money must carry the inherited member $member; saw:\n$src")
            }
            // The chain must not drag the provided root into materialization.
            assertFalse(Files.exists(out.resolve("acme/shop/Currency.kt")),
                "provided Currency must still NOT be materialized")
            val invoice = out.resolve("acme/shop/Invoice.kt").readText()
            assertFalse("com.acme.ext.Money" in invoice,
                "Money is materialized locally, not referenced externally; saw:\n$invoice")
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `provided enum with no namespace config is a codegen error naming the enum`() {
        val ex = assertThrows<RuntimeException> { generate(null) }
        assertTrue(ex.message?.contains("Currency") == true,
            "error must name the provided enum Currency; was: ${ex.message}")
    }

    // =========================================================================
    // Decision table — one shared-enum rule for BOTH JVM generators
    // =========================================================================

    private fun readExpectedEnumTypes(): com.fasterxml.jackson.databind.JsonNode {
        val path = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize()
            .resolve("fixtures/codegen-conformance/shared-provided-enum/expected-enum-types.json")
        assertTrue(Files.exists(path), "expected-enum-types.json must exist at $path")
        return ObjectMapper().readTree(Files.readString(path))
    }

    /** `<package>::<Object>.<field>` -> `{"shared": <declaration FQN>|null, "provided": bool}`,
     *  computed via [Fr019SharedEnum.resolveSharedEnumDecl] for every object-hosted `field.enum`
     *  on every concrete entity/projection/value object — no condition on the hosting object's
     *  subtype. The SAME function [KotlinTypeMapper.enumTypeName] calls for naming. */
    private fun computeDecisionTable(loader: MetaDataLoader): Map<String, Map<String, Any?>> {
        val out = LinkedHashMap<String, Map<String, Any?>>()
        for (owner in loader.metaObjects) {
            val subType = owner.subType
            if (subType != MetaObject.SUBTYPE_ENTITY && subType != MetaObject.SUBTYPE_PROJECTION
                && subType != MetaObject.SUBTYPE_VALUE) continue
            for (field in owner.metaFields) {
                if (field !is EnumField) continue
                val key = "${owner.name}.${field.name}"
                val decl = Fr019SharedEnum.resolveSharedEnumDecl(field)
                out[key] = if (decl == null) {
                    mapOf("shared" to null, "provided" to false)
                } else {
                    mapOf("shared" to decl.name, "provided" to Fr019SharedEnum.isProvided(decl))
                }
            }
        }
        return out
    }

    @Test
    fun `decision table matches shared fixture expectation`() {
        val loader = loadFixture()
        val actual = computeDecisionTable(loader)
        val expected = readExpectedEnumTypes()

        val expectedFields = expected.get("fields")
        val expectedKeys = expectedFields.fieldNames().asSequence().toList()
        for (key in expectedKeys) {
            assertTrue(actual.containsKey(key), "decision table missing key $key; actual keys: ${actual.keys}")
            val expectedEntry = expectedFields.get(key)
            val expectedShared = if (expectedEntry.get("shared").isNull) null else expectedEntry.get("shared").asText()
            val actualEntry = actual.getValue(key)
            assertEquals(expectedShared, actualEntry["shared"], "mismatched 'shared' for $key")
            assertEquals(expectedEntry.get("provided").asBoolean(), actualEntry["provided"], "mismatched 'provided' for $key")
        }
        assertEquals(expectedKeys.size, actual.size, "decision table has extra keys beyond the fixture; actual: ${actual.keys}")

        val expectedMaterialized = expected.get("materialized").map { it.asText() }.sorted()
        val out = Files.createTempDirectory("kgen-fr019-decision-")
        try {
            KotlinEntityGenerator().apply { setArgs(mapOf("outputDir" to out.toString(), "providedEnumNamespace" to "com.acme.ext")) }
                .execute(loadFixture())
            val actualMaterialized = expectedMaterialized.filter { name ->
                Files.exists(out.resolve("acme/shop/$name.kt"))
            }.sorted()
            assertEquals(expectedMaterialized, actualMaterialized,
                "materialized shared enums must match the fixture")
            // And nothing ELSE claiming to be a shared declaration got materialized either —
            // the @provided Currency must never be written.
            assertFalse(Files.exists(out.resolve("acme/shop/Currency.kt")),
                "@provided Currency must never be materialized")
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    // =========================================================================
    // Generated-output assertions — the multi-hop / provided / negative cases
    // =========================================================================

    @Test
    fun `multi-hop projection and value-object fields reference the shared type`() {
        val out = generate("com.acme.ext")
        try {
            // Task.importance (two hops) and Subtask.rank (three hops) both reach Priority.
            // Multi-hop fields reference the ONE shared Priority — on an entity (Task.importance,
            // two hops; Subtask.rank, three hops), a projection (TicketSummary.level) and a value
            // object (TicketBadge.badge) alike — and no per-object enum is written for any of them.
            val shop = out.resolve("acme/shop")
            assertTrue(Files.exists(shop.resolve("Priority.kt")), "shared Priority.kt must be emitted")
            for (stale in listOf("TaskImportance", "TaskUrgency", "SubtaskRank", "TicketSummaryLevel", "TicketBadgeBadge"))
                assertFalse(Files.exists(shop.resolve("$stale.kt")),
                    "$stale.kt must NOT be materialized — the field references the shared type")
            val task = shop.resolve("Task.kt").readText()
            assertTrue("val importance: Priority?" in task, "Task.importance must be typed Priority; saw:\n$task")
            val subtask = shop.resolve("Subtask.kt").readText()
            assertTrue("val rank: Priority" in subtask, "Subtask.rank must be typed Priority; saw:\n$subtask")
            for (name in listOf("TicketSummary.kt", "TicketBadge.kt")) {
                val f = shop.resolve(name)
                if (Files.exists(f)) assertTrue("Priority" in f.readText(), "$name must reference Priority; saw:\n${f.readText()}")
            }
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `refund fields resolve to distinct shared declarations on the same object`() {
        val out = generate("com.acme.ext")
        try {
            val refund = out.resolve("acme/shop/Refund.kt").readText()
            assertTrue("ticketTier" in refund && "invoiceTier" in refund && "unit" in refund
                && "tender" in refund && "orderStatus" in refund,
                "Refund.kt must declare all five fields; saw:\n$refund")
            assertTrue("com.acme.ext.Currency" in refund,
                "Refund.tender must reference the configured external namespace; saw:\n$refund")
        } finally {
            out.toFile().deleteRecursively()
        }
    }

    @Test
    fun `own values or intValueMap stops the walk and keeps an inline per-object enum`() {
        val out = generate("com.acme.ext")
        try {
            // An inline enum is its own per-object file (<Object><Field>.kt) the data class types its
            // property by, and no shared type stands in for it.
            fun assertInline(owner: String, field: String, property: String) {
                val type = owner + field.replaceFirstChar { it.uppercase() }
                val file = out.resolve("acme/shop/$type.kt")
                assertTrue(Files.exists(file), "$owner.$field must keep its inline enum file $type.kt")
                assertTrue("enum class $type" in file.readText(), "$type.kt must declare enum class $type")
                val src = out.resolve("acme/shop/$owner.kt").readText()
                assertTrue("val $property: $type" in src, "$owner.$field must be typed $type; saw:\n$src")
            }
            assertInline("Task", "phase", "phase")
            assertInline("Task", "weight", "weight")
            assertInline("Subtask", "phase", "phase")
            assertInline("Subtask", "weight", "weight")
            assertInline("Refund", "orderStatus", "orderStatus")
        } finally {
            out.toFile().deleteRecursively()
        }
    }
}
