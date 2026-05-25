package com.metaobjects.metadata.ktx

import com.metaobjects.render.InMemoryProvider
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

/**
 * Code samples that appear in `README.md`. Each public sample is exercised here so
 * README drift is caught at compile-time (matches the omdb-ktx README.kt pattern).
 */
class ReadmeSamplesTest {

    @Test fun `load from classpath resource and navigate`() {
        val loader = loadResources("demo", listOf("meta.demo.json"))
        val author = loader.metaObjectOrNull("acme::demo::Author")
        assertNotNull(author)
        assertEquals("value", author.subType)
    }

    @Test fun `look up a prompt template`() {
        val loader = loadResources("demo", listOf("meta.demo.json"))
        val prompt = loader.promptTemplateOrNull("acme::demo::WelcomePrompt")
        assertNotNull(prompt)
        assertEquals("Author", prompt.payloadRef)
    }

    @Test fun `render a prompt via the builder`() {
        val out = render {
            template = "Hello {{name}}, welcome!"
            payload = mapOf("name" to "Ada")
            provider = InMemoryProvider(emptyMap())
        }
        assertEquals("Hello Ada, welcome!", out)
    }
}
