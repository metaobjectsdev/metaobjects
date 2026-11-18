package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadDirectory
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.io.path.isRegularFile
import kotlin.io.path.readText
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * An entity may carry a derived (`origin.*`) field that only a projection reads, with no read
 * view of its own: the shared fixture `entity-derived-filter-gate` (`Member.hasActiveAgreement`,
 * an `origin.first` a projection's `@filter` reaches). Its table, the one `meta migrate` creates,
 * has no column for that field. So the Exposed `MemberTable` must declare none, and no generated
 * read or write may name one; the data class keeps the property, nullable and defaulted, since no
 * row ever fills it.
 */
class KotlinDerivedFieldWithoutReadSourceTest {

    private fun fixtureInput(): Path {
        var cur: Path? = Paths.get("").toAbsolutePath()
        while (cur != null) {
            val candidate = cur.resolve("fixtures/conformance/entity-derived-filter-gate/input")
            if (Files.isDirectory(candidate)) return candidate
            cur = cur.parent
        }
        error("fixtures/conformance/entity-derived-filter-gate not found from ${Paths.get("").toAbsolutePath()}")
    }

    @Test fun `the derived field has no column and no generated read or write names one`() {
        val outDir = Files.createTempDirectory("kderived-no-read-source-")
        try {
            val loader = loadDirectory("entity-derived-filter-gate", fixtureInput())
            for (gen in listOf(
                KotlinEntityGenerator(), KotlinExposedTableGenerator(),
                KotlinRepositoryGenerator(), KotlinSpringControllerGenerator(),
            )) {
                gen.setArgs(mapOf("outputDir" to outDir.toString()))
                gen.execute(loader)
            }
            val files = Files.walk(outDir).filter { it.isRegularFile() }.toList()
            fun source(name: String): String =
                files.single { it.fileName.toString() == name }.readText()

            val table = source("MemberTable.kt")
            assertTrue("object MemberTable : Table(\"members\")" in table, "saw:\n$table")
            assertFalse("hasActiveAgreement" in table || "has_active_agreement" in table,
                "MemberTable must declare no column for the derived field; saw:\n$table")

            val member = source("Member.kt")
            assertTrue("val hasActiveAgreement: Boolean? = null" in member,
                "the data class keeps the derived property, nullable and defaulted; saw:\n$member")

            for (f in files.filter { it.fileName.toString().startsWith("Member") && it.fileName.toString() != "Member.kt" }) {
                val src = f.readText()
                assertFalse("MemberTable.hasActiveAgreement" in src || "[hasActiveAgreement]" in src,
                    "${f.fileName} names a column the members table lacks; saw:\n$src")
            }
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
