package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #544: `identity.primary @sequenceStart` / `@sequenceName` reach the generated Exposed table, so a
 * schema created through `SchemaUtils.create` begins the key at the declared start. Forward-only:
 * Exposed output has no migration path, so a changed start has nothing to emit here. Nothing declared
 * keeps the bare `autoIncrement()`.
 */
class KotlinExposedSequenceStartTest {

    private fun model(identityAttrs: String) = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Ticket", "children": [
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "title", "@maxLength": 100 } },
            { "source.rdb":   { "@table": "tickets" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment"$identityAttrs } }
        ] } }
      ] }
    }""".trimIndent()

    private fun table(identityAttrs: String, exposedApi: String? = null): String {
        val outDir = Files.createTempDirectory("kseq-")
        try {
            val gen = KotlinExposedTableGenerator()
            val args = mutableMapOf("outputDir" to outDir.toString())
            if (exposedApi != null) args["exposedApi"] = exposedApi
            gen.setArgs(args)
            gen.execute(loadString("test", model(identityAttrs)))
            return Files.readString(outDir.resolve("acme/demo/TicketTable.kt"))
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test fun `a declared start draws the key from a sequence that starts there`() {
        val src = table(", \"@sequenceStart\": 1000")
        assertTrue("import org.jetbrains.exposed.sql.Sequence" in src, src)
        assertTrue("val id = long(\"id\").autoIncrement(Sequence(\"tickets_id_seq\", startWith = 1000L))" in src, src)
    }

    @Test fun `a declared name is the sequence name`() {
        val src = table(", \"@sequenceName\": \"ticket_numbers\", \"@sequenceStart\": 5000")
        assertTrue("autoIncrement(Sequence(\"ticket_numbers\", startWith = 5000L))" in src, src)
    }

    @Test fun `a name alone keeps the database default start`() {
        val src = table(", \"@sequenceName\": \"ticket_numbers\"")
        assertTrue("autoIncrement(Sequence(\"ticket_numbers\"))" in src, src)
    }

    @Test fun `nothing declared emits the bare autoIncrement and no Sequence import`() {
        val src = table("")
        assertTrue("val id = long(\"id\").autoIncrement()" in src, src)
        assertFalse("Sequence" in src, src)
    }

    @Test fun `the Exposed 1x line imports Sequence from the v1 core package`() {
        val src = table(", \"@sequenceStart\": 1000", exposedApi = "1")
        assertTrue("import org.jetbrains.exposed.v1.core.Sequence" in src, src)
        assertTrue("autoIncrement(Sequence(\"tickets_id_seq\", startWith = 1000L))" in src, src)
    }
}
