package com.metaobjects.generator.kotlin

import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.relationship.M2MFields
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

/**
 * FW-8 follow-up — an M:N whose declared target is an ABSTRACT mid-level entity (a
 * `@discriminator` node with concrete subtypes below it, but the target of the relationship is
 * itself an intermediate abstract level with no own `@discriminatorValue`) legitimately has no
 * single discriminator value to narrow by: it is never instantiated, and rows of every concrete
 * subtype beneath it are valid targets. [KotlinM2mSupport.resolve] must leave such a nav
 * unfiltered (docs/features/abstracts-and-inheritance.md), NOT throw — that throw is reserved for
 * a genuine resolution failure on a CONCRETE TPH subtype target.
 */
class KotlinM2mSupportAbstractMidLevelTargetTest {

    /** `Party` (`@discriminator`) -> abstract `Auth` (mid-level, no @discriminatorValue) -> {BridgeAuth, CopayAuth}. */
    private val abstractMidLevelFixture = """{
      "metadata.root": { "package": "acme::auth", "children": [
        { "object.entity": { "name": "Party", "children": [
            { "source.rdb":   { "@table": "parties" } },
            { "field.long":   { "name": "id" } },
            { "relationship.association": { "name": "auths", "@cardinality": "many",
                "@objectRef": "Auth", "@through": "PartyAuth" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Auth", "abstract": true, "@discriminator": "type", "children": [
            { "source.rdb":   { "@table": "auths" } },
            { "field.long":   { "name": "id" } },
            { "field.enum":   { "name": "type", "@values": ["Bridge", "Copay"] } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity", "@required": true } }
        ] } },
        { "object.entity": { "name": "CopayAuth", "extends": "Auth", "@discriminatorValue": "Copay", "children": [
            { "field.decimal": { "name": "copayAmount", "@precision": 10, "@scale": 2 } }
        ] } },
        { "object.entity": { "name": "PartyAuth", "children": [
            { "source.rdb":         { "@table": "party_auths" } },
            { "field.long":         { "name": "partyId", "@required": true } },
            { "field.long":         { "name": "authId",  "@required": true } },
            { "identity.primary":   { "@fields": ["partyId", "authId"] } },
            { "identity.reference": { "name": "fkParty", "@fields": "partyId", "@references": "Party" } },
            { "identity.reference": { "name": "fkAuth",  "@fields": "authId",  "@references": "Auth" } }
        ] } }
      ] }
    }""".trimIndent()

    /** Same shape, but `BridgeAuth`'s `@discriminatorValue` is broken: a non-enum discriminator field. */
    private val brokenConcreteDiscriminatorFixture = """{
      "metadata.root": { "package": "acme::auth", "children": [
        { "object.entity": { "name": "Party", "children": [
            { "source.rdb":   { "@table": "parties" } },
            { "field.long":   { "name": "id" } },
            { "relationship.association": { "name": "auths", "@cardinality": "many",
                "@objectRef": "BridgeAuth", "@through": "PartyAuth" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "Auth", "abstract": true, "@discriminator": "type", "children": [
            { "source.rdb":   { "@table": "auths" } },
            { "field.long":   { "name": "id" } },
            { "field.string": { "name": "type", "@maxLength": 20 } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } }
        ] } },
        { "object.entity": { "name": "BridgeAuth", "extends": "Auth", "@discriminatorValue": "Bridge", "children": [
            { "field.int": { "name": "quantity", "@required": true } }
        ] } },
        { "object.entity": { "name": "PartyAuth", "children": [
            { "source.rdb":         { "@table": "party_auths" } },
            { "field.long":         { "name": "partyId", "@required": true } },
            { "field.long":         { "name": "authId",  "@required": true } },
            { "identity.primary":   { "@fields": ["partyId", "authId"] } },
            { "identity.reference": { "name": "fkParty", "@fields": "partyId", "@references": "Party" } },
            { "identity.reference": { "name": "fkAuth",  "@fields": "authId",  "@references": "BridgeAuth" } }
        ] } }
      ] }
    }""".trimIndent()

    private fun loader(fixture: String): MetaDataLoader = loadString("kotlin-m2m-abstract-mid", fixture)

    @Test
    fun `abstract mid-level target resolves with no target discriminator`() {
        val loader = loader(abstractMidLevelFixture)
        val party = loader.getMetaObjectByName("acme::auth::Party")
        val navs = KotlinM2mSupport.resolve(party, loader)
        val nav = navs.single { it.relationName == "auths" }
        assertNull(nav.targetDiscriminator,
            "an abstract mid-level target has no single discriminator value; traversal stays unfiltered")
    }

    @Test
    fun `concrete TPH subtype target with unresolvable discriminator throws`() {
        val loader = loader(brokenConcreteDiscriminatorFixture)
        val party = loader.getMetaObjectByName("acme::auth::Party")
        assertFailsWith<M2MFields.M2MDerivationException> {
            KotlinM2mSupport.resolve(party, loader)
        }
    }
}
