package com.metaobjects.metadata.ktx

import com.metaobjects.relationship.MetaRelationship
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertFails
import kotlin.test.assertTrue

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

    @Test fun `an unresolved objectRef now fails to load`() {
        // A relationship whose @objectRef names no real object is drift between two
        // pieces of metadata — the loader rejects it (ERR_INVALID_RELATIONSHIP) rather
        // than loading a relationship with a silently-null target.
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
        val ex = assertFails { loadString("t2", badFixture) }
        val msg = (ex.message ?: "") + (ex.cause?.message ?: "")
        assertTrue(
            msg.contains("does not resolve") || msg.contains("ERR_INVALID_RELATIONSHIP"),
            "expected a dangling-objectRef load error, got: $msg",
        )
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
