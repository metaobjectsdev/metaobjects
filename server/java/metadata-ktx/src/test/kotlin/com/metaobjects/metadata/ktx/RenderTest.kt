package com.metaobjects.metadata.ktx

import com.metaobjects.render.InMemoryProvider
import com.metaobjects.render.RenderException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class RenderTest {

    @Test fun `render builder renders inline template`() {
        val out = render {
            template = "Hello {{name}}!"
            payload = mapOf("name" to "Ada")
            provider = InMemoryProvider(emptyMap())
        }
        assertEquals("Hello Ada!", out)
    }

    @Test fun `render builder via ref + provider`() {
        val out = render {
            ref = "g/s"
            payload = mapOf("name" to "Bob")
            provider = InMemoryProvider(mapOf("g/s" to "Hi {{name}}"))
        }
        assertEquals("Hi Bob", out)
    }

    @Test fun `render builder default format is text`() {
        val out = render {
            template = "{{value}}"
            payload = mapOf("value" to "<b>raw</b>")
            provider = InMemoryProvider(emptyMap())
        }
        assertEquals("<b>raw</b>", out)
    }

    @Test fun `render builder honors format html`() {
        val out = render {
            template = "{{value}}"
            payload = mapOf("value" to "<b>raw</b>")
            provider = InMemoryProvider(emptyMap())
            format = "html"
        }
        assertEquals("&lt;b&gt;raw&lt;/b&gt;", out)
    }

    @Test fun `render builder throws when neither template nor ref set`() {
        assertFailsWith<RenderException> {
            render {
                payload = mapOf("k" to "v")
                provider = InMemoryProvider(emptyMap())
            }
        }
    }

    @Test fun `render builder throws when both template and ref set`() {
        assertFailsWith<RenderException> {
            render {
                template = "inline"
                ref = "g/s"
                payload = mapOf("k" to "v")
                provider = InMemoryProvider(mapOf("g/s" to "via-ref"))
            }
        }
    }
}
