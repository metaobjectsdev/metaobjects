package com.metaobjects.metadata.ktx

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class MetaObjectsTest {

    private val fixture = """{
      "metadata.root": {
        "package": "acme::ai",
        "children": [
          { "object.value": { "name": "Payload", "children": [
              { "field.string": { "name": "q" } }
          ] } },
          { "template.prompt": { "name": "MyPrompt",
              "@payloadRef": "Payload",
              "@textRef": "ai/p" } },
          { "template.output": { "name": "MyOutput",
              "@payloadRef": "Payload",
              "@textRef": "ai/o" } }
        ]
      }
    }"""

    private fun loader() = loadString("t", fixture)

    @Test fun `metaObjectOrNull returns object when present`() {
        val obj = loader().metaObjectOrNull("acme::ai::Payload")
        assertNotNull(obj)
        assertEquals("value", obj.subType)
    }

    @Test fun `metaObjectOrNull returns null when absent`() {
        assertNull(loader().metaObjectOrNull("acme::ai::NoSuch"))
    }

    @Test fun `templateOrNull returns base type when present`() {
        val t = loader().templateOrNull("acme::ai::MyPrompt")
        assertNotNull(t)
        assertEquals("prompt", t.subType)
    }

    @Test fun `promptTemplateOrNull returns null for output template`() {
        assertNull(loader().promptTemplateOrNull("acme::ai::MyOutput"))
    }

    @Test fun `outputTemplateOrNull returns null for prompt template`() {
        assertNull(loader().outputTemplateOrNull("acme::ai::MyPrompt"))
    }

    @Test fun `promptTemplateOrNull returns typed when present`() {
        val p = loader().promptTemplateOrNull("acme::ai::MyPrompt")
        assertNotNull(p)
        assertEquals("Payload", p.payloadRef)
    }
}
