package com.metaobjects.generator.kotlin

import com.metaobjects.database.PhysicalNaming
import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.util.GeneratorUtil
import com.metaobjects.generator.util.RouteNaming
import com.metaobjects.metadata.ktx.loadString
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * The Kotlin seam DELEGATES the collection-URL spelling to the shared
 * `RouteNaming` rather than carrying its own copy.
 *
 * A single regular word reads the same under the old rule (`lowercase + "s"`) and
 * the new one, so `Author` alone would pass either way — which is how this port
 * shipped `/postcategorys` with every corpus green. The multi-word and consonant+y
 * cases are what actually pin the delegation. The full table lives in codegen-base's
 * `RouteNamingTest`; the end-to-end gate is the `PostCategory` scenario in
 * `fixtures/api-contract-conformance/m2m/`.
 */
class KotlinRouteNamingTest {

    @Test
    fun `collection segment is the entity name snake cased then pluralized`() {
        // Unchanged by the new rule — the cases that hid the divergence.
        assertEquals("authors", KotlinNaming.collectionSegment("Author"))
        assertEquals("persons", KotlinNaming.collectionSegment("Person"))
        assertEquals("accounts", KotlinNaming.collectionSegment("Account"))

        // Multi-word: separated, and the plural is irregular-aware.
        assertEquals("post_categories", KotlinNaming.collectionSegment("PostCategory"))
        assertEquals("order_summaries", KotlinNaming.collectionSegment("OrderSummary"))

        // A run of capitals stays together until the final one that begins a word.
        assertEquals("http_servers", KotlinNaming.collectionSegment("HTTPServer"))
    }

    @Test
    fun `controller path mounts the collection segment under api`() {
        assertEquals("/api/authors", KotlinNaming.controllerPath("Author"))
        assertEquals("/api/post_categories", KotlinNaming.controllerPath("PostCategory"))
    }

    private fun model(extra: String) = """{
      "metadata.root": { "package": "acme::blog", "children": [
        { "object.entity": { "name": "Author", $extra "children": [
            { "field.long":   { "name": "id" } },
            { "source.rdb":   { "@table": "authors" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun routeFor(extra: String, pluralizer: String?): String {
        val outDir = Files.createTempDirectory("kroute-")
        try {
            val loader = loadString("route", model(extra))
            if (pluralizer != null) loader.root.setPhysicalNaming(PhysicalNaming.of("snake_case", "snake_case", pluralizer))
            val gen = KotlinSpringControllerGenerator()
            gen.setArgs(mapOf("outputDir" to outDir.toString()))
            gen.execute(loader)
            val src = Files.readString(outDir.resolve("acme/blog/AuthorController.kt"))
            val m = Regex("@RequestMapping\\(\"([^\"]*)\"\\)").find(src)
            assertTrue(m != null, src)
            return m.groupValues[1]
        } finally {
            outDir.toFile().deleteRecursively()
        }
    }

    @Test
    fun `controller path honours a declared collection name and the configured pluralizer`() {
        // Shared contract: fixtures/naming-conformance/collection-segments.json.
        val declared = "\"@collectionName\": \"People\","
        assertEquals("/api/authors", routeFor("", null))
        assertEquals("/api/people", routeFor(declared, null))
        assertEquals("/api/author", routeFor("", "none"))
        assertEquals("/api/people", routeFor(declared, "none"))
    }

    private fun twoEntities(a: String, aExtra: String, b: String, bExtra: String) = """{
      "metadata.root": { "package": "acme::shop", "children": [
        { "object.entity": { "name": "$a", $aExtra "children": [
            { "field.long": { "name": "id" } },
            { "source.rdb": { "@table": "t_${a.lowercase()}" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ] } },
        { "object.entity": { "name": "$b", $bExtra "children": [
            { "field.long": { "name": "id" } },
            { "source.rdb": { "@table": "t_${b.lowercase()}" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ] } }
      ] }
    }""".trimIndent()

    /**
     * The collection-name clash, on a model the Kotlin facade loads: two entities whose
     * controllers would mount one REST collection are refused (ERR_COLLECTION_NAME_COLLISION),
     * whether the plurals coincide or a declared `@collectionName` repeats another's segment.
     * The refusal is the shared JVM one the Maven goal runs before the Kotlin generators.
     */
    @Test
    fun `two entities claiming one collection are refused`() {
        for ((label, json) in listOf(
            "plurals coincide" to twoEntities("Address", "", "Addresses", ""),
            "declared name repeats a segment" to twoEntities("Person", "", "Member", "\"@collectionName\": \"Persons\","),
        )) {
            val loader = loadString("clash", json)
            val own = GeneratorUtil.ownMetaObjects(loader)
            val e = assertFailsWith<GeneratorException>(label) { RouteNaming.assertNoCollectionNameCollisions(own) }
            assertTrue("ERR_COLLECTION_NAME_COLLISION" in e.message!!, "$label: ${e.message}")
            val segments = own.map { KotlinNaming.controllerPath(it) }.toSet()
            assertEquals(1, segments.size, "$label: the Kotlin controllers would share one path, saw $segments")
        }
        // Distinct segments load and pass.
        RouteNaming.assertNoCollectionNameCollisions(GeneratorUtil.ownMetaObjects(loadString("ok", twoEntities("Person", "", "Member", ""))))
    }
}
