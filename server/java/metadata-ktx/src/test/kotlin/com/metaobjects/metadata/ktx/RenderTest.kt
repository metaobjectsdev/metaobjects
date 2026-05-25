package com.metaobjects.metadata.ktx

import com.metaobjects.render.InMemoryProvider
import kotlin.test.Test
import kotlin.test.assertEquals

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
}
