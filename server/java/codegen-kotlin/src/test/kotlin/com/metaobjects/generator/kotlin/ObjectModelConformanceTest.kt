/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.generator.kotlin

import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.metadata.ktx.loadString
import com.metaobjects.`object`.MetaObject
import com.metaobjects.`object`.MetaObjectAware
import com.metaobjects.`object`.value.ValueObject
import com.metaobjects.registry.ObjectClassBindingProvider
import com.metaobjects.registry.ObjectClassRegistry
import com.metaobjects.util.MetaDataUtil
import java.nio.file.Files
import java.nio.file.Path
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * Kotlin conformance runner for the shared `fixtures/object-model-conformance/` corpus.
 *
 * Kotlin reuses the JVM runtime object model — the very same Java [MetaObject],
 * [MetaField][com.metaobjects.field.MetaField], [ValueObject], [ObjectClassRegistry]
 * + `newInstance()` factory that the Java reference runner exercises. There is no
 * Kotlin-side object-model code; this runner is a direct transliteration of the Java
 * reference (`server/java/metadata/.../ObjectModelConformanceTest.java`), calling the
 * identical Java API. Because it drives the model Java already validated 7/7, passing
 * here proves the JVM model satisfies the corpus from the Kotlin port too.
 *
 * Assertions are behavioral (type-kind, back-ref identity, field values, list
 * contents, overflow) — not byte-identity. The corpus declares `object.value`
 * Person{name:string, age:int, home:Address, tags:Tag[]}, Address{street,city},
 * Tag{label} in package `com::example::om`
 * (see `fixtures/object-model-conformance/README.md`).
 */
class ObjectModelConformanceTest {

    private val pkg = "com::example::om"
    private val personFqn = "$pkg::Person"
    private val addressFqn = "$pkg::Address"
    private val tagFqn = "$pkg::Tag"

    // -----------------------------------------------------------------------
    // Corpus loading
    // -----------------------------------------------------------------------

    /**
     * Resolve `fixtures/object-model-conformance/` by walking up from the current
     * working directory — the repo-root-walk idiom the sibling runners use.
     */
    private fun locateCorpus(): Path {
        var dir: Path? = Path.of(System.getProperty("user.dir")).toAbsolutePath()
        while (dir != null) {
            val candidate = dir.resolve("fixtures/object-model-conformance")
            if (Files.isDirectory(candidate)) return candidate
            dir = dir.parent
        }
        throw AssertionError(
            "Could not locate fixtures/object-model-conformance/ by walking up from: " +
                Path.of("").toAbsolutePath(),
        )
    }

    /**
     * Load the corpus `meta.json` through a FRESH loader (own MetaObject instances).
     * A fresh loader per call matters for the bound-type scenario:
     * [MetaObject.getObjectClass] caches the resolved class per instance, so the
     * registry binding must be installed before the first `newInstance()` on a
     * never-before-touched MetaObject.
     */
    private fun loadCorpus(loaderName: String): MetaDataLoader {
        val meta = locateCorpus().resolve("meta.json")
        assertTrue(Files.exists(meta), "corpus meta.json missing at $meta")
        val canonical = Files.readString(meta)
        return loadString("object-model-conformance-$loaderName", canonical)
    }

    @AfterTest
    fun resetRegistry() {
        // The bound-type scenario installs a process-global registry; never leak it.
        ObjectClassRegistry.resetGlobal()
    }

    // -----------------------------------------------------------------------
    // Scenario 1 — instantiate-value
    // -----------------------------------------------------------------------

    @Test
    fun scenario1_instantiateValue() {
        val loader = loadCorpus("s1")
        val person = loader.getMetaObjectByName(personFqn)
        assertNotNull(person, "Person MetaObject must load")

        val p = person.newInstance()
        assertTrue(
            p is ValueObject,
            "object.value default instance must be the map-backed ValueObject, was ${p.javaClass.name}",
        )
        assertSame(
            person, (p as MetaObjectAware).metaData,
            "instance back-reference must be the Person MetaObject",
        )
    }

    // -----------------------------------------------------------------------
    // Scenario 2 — scalar-round-trip
    // -----------------------------------------------------------------------

    @Test
    fun scenario2_scalarRoundTrip() {
        val loader = loadCorpus("s2")
        val person = loader.getMetaObjectByName(personFqn)

        val p = person.newInstance()
        person.getMetaField("name").setString(p, "Ada")
        person.getMetaField("age").setInt(p, 36)

        assertEquals("Ada", person.getMetaField("name").getString(p))
        assertEquals(36, person.getMetaField("age").getInt(p))
    }

    // -----------------------------------------------------------------------
    // Scenario 3 — nested-object
    // -----------------------------------------------------------------------

    @Test
    fun scenario3_nestedObject() {
        val loader = loadCorpus("s3")
        val person = loader.getMetaObjectByName(personFqn)

        val address = MetaDataUtil.getObjectRef(person.getMetaField("home"))
        assertNotNull(address, "home @objectRef must resolve to the Address MetaObject")
        assertEquals(addressFqn, address.name)

        val addr = address.newInstance()
        address.getMetaField("street").setString(addr, "1 Main")
        address.getMetaField("city").setString(addr, "Anytown")

        val p = person.newInstance()
        person.getMetaField("home").setObject(p, addr)

        val got = person.getMetaField("home").getObject(p)
        assertNotNull(got, "home must round-trip")
        assertEquals("1 Main", address.getMetaField("street").getString(got))
        assertEquals("Anytown", address.getMetaField("city").getString(got))
        assertSame(
            address, (got as MetaObjectAware).metaData,
            "nested instance back-reference must be the Address MetaObject",
        )
    }

    // -----------------------------------------------------------------------
    // Scenario 4 — array-of-objects
    // -----------------------------------------------------------------------

    @Test
    fun scenario4_arrayOfObjects() {
        val loader = loadCorpus("s4")
        val person = loader.getMetaObjectByName(personFqn)

        val tag = MetaDataUtil.getObjectRef(person.getMetaField("tags"))
        assertNotNull(tag, "tags @objectRef must resolve to the Tag MetaObject")
        assertEquals(tagFqn, tag.name)

        val t1 = tag.newInstance()
        tag.getMetaField("label").setString(t1, "a")
        val t2 = tag.newInstance()
        tag.getMetaField("label").setString(t2, "b")

        val p = person.newInstance()
        person.getMetaField("tags").setObjectArray(p, listOf(t1, t2))

        val got = person.getMetaField("tags").getObjectArray(p)
        assertNotNull(got, "tags must round-trip")
        assertEquals(2, got.size, "ordered list of 2")
        assertEquals("a", tag.getMetaField("label").getString(got[0]))
        assertEquals("b", tag.getMetaField("label").getString(got[1]))
        assertSame(
            tag, (got[0] as MetaObjectAware).metaData,
            "element 0 back-reference must be the Tag MetaObject",
        )
        assertSame(
            tag, (got[1] as MetaObjectAware).metaData,
            "element 1 back-reference must be the Tag MetaObject",
        )
    }

    // -----------------------------------------------------------------------
    // Scenario 5 — overflow (an instance may hold more than the declared field set)
    // -----------------------------------------------------------------------

    @Test
    fun scenario5_overflow() {
        val loader = loadCorpus("s5")
        val person = loader.getMetaObjectByName(personFqn)

        val p = person.newInstance() as ValueObject
        // The map-backed value object can hold more than the declared field set.
        // object.value defaults to strict/non-extension; the public API to opt an
        // instance into overflow is allowExtensions(true) (no @allowExtensions attr
        // is declared in the corpus, so the production default stays strict).
        p.allowExtensions(true)
        p.put("nickname", "Ace")
        assertEquals("Ace", p.get("nickname"))
    }

    // -----------------------------------------------------------------------
    // Scenario 6 — bound-type
    //
    // Register a port-local "aware" type for the Person FQN in the
    // ObjectClassRegistry, then newInstance(Person) returns THAT type.
    //
    // Scoping (no leak): install a process-global registry holding ONLY the Person
    // binding, exercise it on a FRESH loader (fresh MetaObject instance, so
    // getObjectClass()'s per-instance cache resolves with the binding active), and
    // reset the global registry in @AfterTest.
    // -----------------------------------------------------------------------

    @Test
    fun scenario6_boundType() {
        val scoped = ObjectClassRegistry()
        scoped.register(object : ObjectClassBindingProvider {
            override fun bindings(): Map<String, Class<*>> = mapOf(personFqn to PersonPojoKt::class.java)
        })
        ObjectClassRegistry.setGlobal(scoped)

        val loader = loadCorpus("s6")
        val person = loader.getMetaObjectByName(personFqn)
        val address = MetaDataUtil.getObjectRef(person.getMetaField("home"))
        val tag = MetaDataUtil.getObjectRef(person.getMetaField("tags"))

        val p = person.newInstance()
        assertTrue(
            p is PersonPojoKt,
            "bound FQN must instantiate the registered type, was ${p.javaClass.name}",
        )
        assertSame(
            person, (p as MetaObjectAware).metaData,
            "bound instance back-reference must be the Person MetaObject",
        )

        // scalar
        person.getMetaField("name").setString(p, "Ada")
        person.getMetaField("age").setInt(p, 36)
        assertEquals("Ada", person.getMetaField("name").getString(p))
        assertEquals(36, person.getMetaField("age").getInt(p))

        // nested (Address still falls back to ValueObject — only Person is bound)
        val addr = address.newInstance()
        address.getMetaField("street").setString(addr, "1 Main")
        address.getMetaField("city").setString(addr, "Anytown")
        person.getMetaField("home").setObject(p, addr)
        val gotHome = person.getMetaField("home").getObject(p)
        assertEquals("1 Main", address.getMetaField("street").getString(gotHome))
        assertEquals("Anytown", address.getMetaField("city").getString(gotHome))

        // array
        val t1 = tag.newInstance()
        tag.getMetaField("label").setString(t1, "a")
        val t2 = tag.newInstance()
        tag.getMetaField("label").setString(t2, "b")
        person.getMetaField("tags").setObjectArray(p, listOf(t1, t2))
        val gotTags = person.getMetaField("tags").getObjectArray(p)
        assertEquals(2, gotTags.size)
        assertEquals("a", tag.getMetaField("label").getString(gotTags[0]))
        assertEquals("b", tag.getMetaField("label").getString(gotTags[1]))
    }

    // -----------------------------------------------------------------------
    // Scenario 7 — no-binding-fallback
    // -----------------------------------------------------------------------

    @Test
    fun scenario7_noBindingFallback() {
        // Default (discovered) registry — nothing bound for Address.
        val loader = loadCorpus("s7")
        val address = loader.getMetaObjectByName(addressFqn)
        assertNotNull(address, "Address MetaObject must load")

        val addr = address.newInstance()
        assertTrue(
            addr is ValueObject,
            "with no binding, Address must fall back to ValueObject, was ${addr.javaClass.name}",
        )
    }

    // -----------------------------------------------------------------------
    // Test-only bound POJO for scenario 6 (Kotlin transliteration of the Java
    // PersonPojoFixture). Implements MetaObjectAware so MetaObject.newInstance()
    // attaches the Person back-reference after the no-arg ctor. Field shape mirrors
    // the corpus Person: name:String, age:Int?, home:Any?, tags:List<*>?. Field
    // access goes through plain getters/setters; the value-access layer reads/writes
    // these, so scalar/nested/array round-trips behave identically to a ValueObject.
    // -----------------------------------------------------------------------

    class PersonPojoKt : MetaObjectAware {
        private var metaData: MetaObject? = null

        var name: String? = null
        var age: Int? = null
        var home: Any? = null
        var tags: List<*>? = null

        override fun getMetaData(): MetaObject? = metaData

        override fun setMetaData(metaObject: MetaObject) {
            this.metaData = metaObject
        }
    }
}
