package com.metaobjects.metadata.ktx

import com.metaobjects.relationship.MetaRelationship
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class RelationshipsTest {

    private val fixture = """{
      "metadata.root": {
        "package": "acme",
        "children": [
          { "object.entity": { "name": "Author", "children": [
              { "field.long": { "name": "id" } },
              { "identity.primary": { "@fields": "id" } }
          ] } },
          { "object.entity": { "name": "Post", "children": [
              { "field.long": { "name": "id" } },
              { "field.long": { "name": "authorId" } },
              { "identity.primary": { "@fields": "id" } },
              { "relationship.composition": { "name": "author",
                  "@objectRef": "Author",
                  "@cardinality": "one" } }
          ] } }
        ]
      }
    }"""

    private fun relationship(): MetaRelationship =
        loadString("t", fixture).metaObjectOrNull("acme::Post")!!
            .children.filterIsInstance<MetaRelationship>().first()

    @Test fun `cardinality maps to enum`() {
        assertEquals(Cardinality.ONE, relationship().cardinalityType)
    }

    @Test fun `targetObjectOrNull resolves bare name`() {
        val target = relationship().targetObjectOrNull
        assertNotNull(target)
        assertEquals("Author", target.shortName)
    }

    @Test fun `targetObjectOrNull is null when objectRef is unresolved`() {
        val badFixture = """{
          "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Post", "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": "id" } },
                { "relationship.composition": { "name": "ghost",
                    "@objectRef": "NoSuch",
                    "@cardinality": "one" } }
            ] } }
          ] }
        }"""
        val rel = loadString("t2", badFixture).metaObjectOrNull("acme::Post")!!
            .children.filterIsInstance<MetaRelationship>().first()
        assertNull(rel.targetObjectOrNull)
    }

    @Test fun `cardinalityType defaults to ONE when attr absent`() {
        // MetaRelationship.getCardinality() defaults to "one" when absent;
        // the typed extension mirrors that.
        val noCardFixture = """{
          "metadata.root": { "package": "acme", "children": [
            { "object.entity": { "name": "Author", "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": "id" } }
            ] } },
            { "object.entity": { "name": "Post", "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": "id" } },
                { "relationship.composition": { "name": "author",
                    "@objectRef": "Author" } }
            ] } }
          ] }
        }"""
        val rel = loadString("t3", noCardFixture).metaObjectOrNull("acme::Post")!!
            .children.filterIsInstance<MetaRelationship>().first()
        assertEquals(Cardinality.ONE, rel.cardinalityType)
    }
}
