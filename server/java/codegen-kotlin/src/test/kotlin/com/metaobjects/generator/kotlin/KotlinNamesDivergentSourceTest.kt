package com.metaobjects.generator.kotlin

import com.metaobjects.generator.GeneratorException
import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.source.RdbSource
import com.metaobjects.source.MetaSource
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * [KotlinGenUtil.resolveObjectNames] refuses an object whose `@role: primary` sources
 * disagree on a physical name — in BOTH directions.
 *
 * `ValidateOnePrimarySource` enforces "exactly one primary" over OWN children only, and
 * effective-children shadowing matches an own child over a super child only on a
 * `(type, name)` pair — so two `source.rdb` nodes with DIFFERENT explicit names at two
 * levels of an `extends` chain never collide, and both survive the resolving source walk.
 * Each fixture below is asserted to load with ZERO errors first: a guard test whose
 * fixture the loader would reject proves nothing.
 *
 * **Direction 1** is what the old check could see: the inherited primary is READ-ONLY, so
 * `findPrimaryWritableSource` skipped it and matched the child's, and the two disagreed.
 * **Direction 2** is what it could not: both primaries are WRITABLE, so both selectors
 * landed on the same inherited node, agreed, and the guard stayed silent — while every
 * generated artifact bound the parent's table over the child's own declaration.
 *
 * This file also retires a claim the port carried in a comment: that the divergence
 * "could not be constructed on THIS port" because `object.base` is not instantiable on
 * the JVM. That reasoned from one shape and generalised. Neither fixture here uses
 * `object.base` — an `object.entity` may extend an abstract `object.projection` (only a
 * PROJECTION is restricted to extending projections), and two plain entities each naming
 * their own table need no exotic subtype at all.
 */
class KotlinNamesDivergentSourceTest {

    private val readOnlyInherited = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "Base", "children": [
            { "source.rdb": { "name": "s", "@table": "bases" } },
            { "field.long": { "name": "id" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ] } },
        { "object.projection": { "name": "ParentWeird", "abstract": true, "children": [
            { "source.rdb": { "name": "viewSrc", "@kind": "view", "@view": "v_parent" } },
            { "field.long": { "name": "id", "extends": "Base.id" } }
        ] } },
        { "object.entity": { "name": "ChildWeird", "extends": "ParentWeird", "children": [
            { "source.rdb": { "name": "tableSrc", "@table": "child_table" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ] } }
      ] }
    }""".trimIndent()

    private val bothWritable = """{
      "metadata.root": { "package": "acme::demo", "children": [
        { "object.entity": { "name": "ParentWeird", "abstract": true, "children": [
            { "source.rdb": { "name": "parentSrc", "@table": "parent_table" } },
            { "field.long": { "name": "id" } }
        ] } },
        { "object.entity": { "name": "ChildWeird", "extends": "ParentWeird", "children": [
            { "source.rdb": { "name": "childSrc", "@table": "child_table" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } }
        ] } }
      ] }
    }""".trimIndent()

    private fun assertRefused(fixture: String, id: String, otherName: String) {
        val loader = loadString(id, fixture)
        // The header claims this; assert it rather than trust it. `loadString` COLLECTS
        // child-level errors instead of throwing, so without this line a fixture that
        // stopped loading would sail through every assertion below.
        assertEquals(emptyList(), loader.getErrors().map { it.message }, "fixture must load cleanly")
        val child = loader.metaObjects.single { it.name.endsWith("::ChildWeird") }

        // Pin the reachability MECHANISM: both sources survive the child merge. If one
        // shadowed the other there would be no divergence and this would pass vacuously.
        val primaries = child.getSources(true).filterIsInstance<RdbSource>()
            .filter { MetaSource.ROLE_PRIMARY == it.role }
            .map { it.physicalName }
            .sorted()
        assertEquals(listOf(otherName, "child_table").sorted(), primaries)

        val ex = assertFailsWith<GeneratorException> { KotlinGenUtil.resolveObjectNames(child) }
        // Each substring asserted separately, so a message dropping one still fails.
        assertTrue("ChildWeird" in ex.message!!, ex.message!!)
        assertTrue(otherName in ex.message!!, ex.message!!)
        assertTrue("child_table" in ex.message!!, ex.message!!)
    }

    @Test
    fun `direction 1 - a read-only inherited primary beside a writable own primary is refused`() {
        assertRefused(readOnlyInherited, "divergent-ro", "v_parent")
    }

    @Test
    fun `direction 2 - two WRITABLE primaries disagreeing on a table name is refused`() {
        assertRefused(bothWritable, "divergent-w", "parent_table")
    }

    @Test
    fun `two primaries AGREEING on a physical name are not refused`() {
        // The guard is about DISAGREEMENT, not about the count. Refusing two primaries
        // that name the same relation would make it stricter than the invariant it
        // protects: an object has ONE physical name, not one source declaration.
        val fixture = """{
          "metadata.root": { "package": "acme::demo", "children": [
            { "object.entity": { "name": "ParentSame", "abstract": true, "children": [
                { "source.rdb": { "name": "parentSrc", "@table": "same_table" } },
                { "field.long": { "name": "id" } }
            ] } },
            { "object.entity": { "name": "ChildSame", "extends": "ParentSame", "children": [
                { "source.rdb": { "name": "childSrc", "@table": "same_table" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"] } }
            ] } }
          ] }
        }""".trimIndent()
        val loader = loadString("divergent-same", fixture)
        val child = loader.metaObjects.single { it.name.endsWith("::ChildSame") }
        assertEquals("same_table", KotlinGenUtil.resolveObjectNames(child)!!.name)
    }
}
