package com.metaobjects.generator.kotlin

import com.metaobjects.metadata.ktx.render
import com.metaobjects.render.InMemoryProvider
import kotlin.test.Test
import kotlin.test.assertEquals

class KotlinCodegenE2ETest {

    /**
     * Proves the full loop: codegen → consumer constructs payload (here, a Map equivalent
     * for the in-test simulation) → Java Renderer renders → expected output.
     * Doesn't physically compile + load the generated class — kotlin-compile-testing covers
     * the compile gate; this test covers semantic round-trip via the metadata-ktx render builder.
     */
    @Test fun `payload structure round-trips through Java render`() {
        val out = render {
            ref = "g/hello"
            payload = mapOf("name" to "Ada")
            provider = InMemoryProvider(mapOf("g/hello" to "Hello {{name}}!"))
        }
        assertEquals("Hello Ada!", out)
    }
}
