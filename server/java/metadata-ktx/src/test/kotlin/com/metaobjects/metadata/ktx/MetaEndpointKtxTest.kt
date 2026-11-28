package com.metaobjects.metadata.ktx

import com.metaobjects.io.json.CanonicalJsonSerializer
import com.metaobjects.io.json.MetaEndpoint
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Kotlin consumes the Java [MetaEndpoint] symbol directly — there is no separate Kotlin
 * implementation of the GET /_meta contract. These tests prove it is reachable, and behaves
 * correctly, from the Kotlin facade.
 */
class MetaEndpointKtxTest {

    private val tinyJson = """{ "metadata.root": { "package": "acme", "children": [] } }"""

    @Test fun `the route path is the cross-port contract value`() {
        assertEquals("/_meta", MetaEndpoint.META_ROUTE_PATH)
    }

    @Test fun `metaJson is callable from kotlin and matches the effective serialization`() {
        val loader = loadString("meta-endpoint-ktx-test", tinyJson)
        assertEquals(
            CanonicalJsonSerializer.canonicalSerializeEffective(loader.root),
            MetaEndpoint.metaJson(loader.root))
    }

    @Test fun `the docs view route is reachable from kotlin and tags its body`() {
        val loader = loadString("meta-docs-endpoint-ktx-test", tinyJson)
        val docs = MetaEndpoint.docs(loader.root)
        assertEquals("/_meta/docs", MetaEndpoint.META_DOCS_ROUTE_PATH)
        assertEquals(MetaEndpoint.metaDocsJson(loader.root), docs.body())
        assertEquals(MetaEndpoint.metaDocsEtag(docs.body()), docs.etag())
        kotlin.test.assertTrue(docs.matches(docs.etag()))
    }
}
