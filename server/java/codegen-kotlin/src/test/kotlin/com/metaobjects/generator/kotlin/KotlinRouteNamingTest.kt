package com.metaobjects.generator.kotlin

import kotlin.test.Test
import kotlin.test.assertEquals

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
}
