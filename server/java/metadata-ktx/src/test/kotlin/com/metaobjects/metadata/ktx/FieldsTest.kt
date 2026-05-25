package com.metaobjects.metadata.ktx

import com.metaobjects.field.IntegerField
import com.metaobjects.field.MetaField
import com.metaobjects.field.StringField
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class FieldsTest {

    private val fixture = """{
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.value": { "name": "P", "children": [
              { "field.string": { "name": "s" } },
              { "field.int":    { "name": "i" } }
          ] } }
        ]
      }
    }"""

    private fun obj() = loadString("t", fixture).metaObjectOrNull("acme::P")!!

    @Test fun `reified field returns typed value when present and right type`() {
        val s = obj().field<StringField>("s")
        assertNotNull(s)
    }

    @Test fun `reified field returns null when absent`() {
        assertNull(obj().field<StringField>("missing"))
    }

    @Test fun `reified field returns null when wrong subtype`() {
        assertNull(obj().field<IntegerField>("s"))
    }

    @Test fun `requireField throws when absent`() {
        assertFailsWith<Exception> { obj().requireField<StringField>("missing") }
    }

    @Test fun `fieldsOfType filters by subtype`() {
        assertEquals(1, obj().fieldsOfType<StringField>().size)
        assertEquals(1, obj().fieldsOfType<IntegerField>().size)
        assertEquals(2, obj().fieldsOfType<MetaField<*>>().size)
    }
}
