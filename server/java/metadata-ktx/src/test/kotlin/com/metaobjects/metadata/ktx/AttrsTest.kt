package com.metaobjects.metadata.ktx

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class AttrsTest {

    private val fixture = """{
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.value": { "name": "P", "children": [
              { "field.string": { "name": "s", "@maxLength": 100 } }
          ] } }
        ]
      }
    }"""

    private fun strField() = loadString("t", fixture).metaObjectOrNull("acme::P")!!.getMetaField("s")

    @Test fun `attrOrNull returns attr when present`() {
        assertNotNull(strField().attrOrNull("maxLength"))
    }

    @Test fun `attrOrNull returns null when absent`() {
        assertNull(strField().attrOrNull("nope"))
    }

    @Test fun `attrStringOrNull returns string value`() {
        assertEquals("100", strField().attrStringOrNull("maxLength"))
    }
}
