package com.metaobjects.metadata.ktx

import com.metaobjects.identity.MetaIdentity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class IdentityTest {

    private fun identityWithGeneration(gen: String): MetaIdentity {
        val json = """{
          "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "E", "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": "id", "@generation": "$gen" } }
            ] } }
          ] }
        }"""
        return loadString("t", json).metaObjectOrNull("acme::E")!!
            .children.filterIsInstance<MetaIdentity>().first()
    }

    @Test fun `INCREMENT maps`() {
        assertEquals(IdentityGeneration.INCREMENT, identityWithGeneration("increment").generationStrategy)
    }

    @Test fun `UUID maps`() {
        assertEquals(IdentityGeneration.UUID, identityWithGeneration("uuid").generationStrategy)
    }

    @Test fun `ASSIGNED maps`() {
        assertEquals(IdentityGeneration.ASSIGNED, identityWithGeneration("assigned").generationStrategy)
    }

    @Test fun `absent generation returns null`() {
        val json = """{
          "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "E", "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": "id" } }
            ] } }
          ] }
        }"""
        val identity = loadString("t", json).metaObjectOrNull("acme::E")!!
            .children.filterIsInstance<MetaIdentity>().first()
        assertNull(identity.generationStrategy)
    }
}
