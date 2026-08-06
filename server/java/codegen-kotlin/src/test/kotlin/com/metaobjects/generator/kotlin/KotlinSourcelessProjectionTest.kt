package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.io.path.name
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #271 — a projection with NO `source.*` anywhere in its super chain is not backed by
 * any store, so the Exposed table generator must emit nothing for it.
 *
 * This is the shape #210 makes common: a prompt payload becomes a sourceless
 * projection. The generator already handles it correctly — it does a RESOLVING source
 * lookup and skips on absence (`firstRdbSource(entity) ?: continue`) rather than
 * dispatching on the object subtype — but nothing pinned that. A future edit that
 * reintroduced a subtype-keyed check would emit an Exposed `Table` object naming a
 * table that does not exist, and the break would surface at query time.
 *
 * The projection reuses the entity's field SHAPE via field-level `extends`, which
 * carries field properties and NOT object children, so it inherits no source. A
 * projection cannot extend an entity at all (FR-024/ADR-0028), which is why
 * "sourceless projection" is a crisp reachable shape rather than an accident.
 */
class KotlinSourcelessProjectionTest {

    private val fixture = """
    { "metadata.root": { "package": "acme::blog", "children": [
      { "object.entity": { "name": "Author", "children": [
        { "source.rdb":   { "@table": "authors" } },
        { "field.long":   { "name": "id" } },
        { "field.string": { "name": "name", "@required": true, "@maxLength": 200 } },
        { "identity.primary": { "@fields": "id", "@generation": "increment" } }
      ] } },
      { "object.projection": { "name": "AuthorPayload", "children": [
        { "field.string": { "name": "name", "extends": "acme::blog::Author.name" } },
        { "field.string": { "name": "summary" } }
      ] } }
    ] } }
    """.trimIndent()

    @Test
    fun `sourceless projection emits no Exposed table`() {
        val outDir = Files.createTempDirectory("ksourceless-")
        try {
            val loader = loadString("sourceless-projection", fixture)

            // Guard against a false green: if the projection were REJECTED while the
            // entity loaded, both assertions below would pass for the wrong reason.
            assertTrue(
                loader.getMetaObjectByName("acme::blog::AuthorPayload") != null,
                "the sourceless projection must load — it is the subject of this test",
            )

            KotlinExposedTableGenerator().apply { setArgs(mapOf("outputDir" to outDir.toString())) }
                .execute(loader)

            val emitted = Files.walk(outDir).filter { Files.isRegularFile(it) }.toList()
            val names = emitted.map { it.name }

            // The sourced entity still emits its table — the no-churn half.
            assertTrue(
                names.any { it.contains("Author") && !it.contains("AuthorPayload") },
                "expected an Exposed table for the sourced entity Author; got $names",
            )
            // The sourceless projection emits nothing.
            assertFalse(
                names.any { it.contains("AuthorPayload") },
                "a sourceless projection has no table to map; got $names",
            )
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }
}
