/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects. All Rights Reserved.
 *
 * This software is the proprietary information of Doug Mealing LLC dba Meta Objects.
 * Use is subject to license terms.
 */
package com.metaobjects.object;

import com.metaobjects.field.MetaField;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.ObjectClassBindingProvider;
import com.metaobjects.registry.ObjectClassRegistry;
import com.metaobjects.registry.SharedRegistryTestBase;
import com.metaobjects.util.MetaDataUtil;
import org.junit.After;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

/**
 * Java reference conformance runner for the shared
 * {@code fixtures/object-model-conformance/} corpus.
 *
 * <p>Java already ships the full runtime object model ({@link MetaObject},
 * {@link MetaField}, {@link ValueObject}, {@link ObjectClassRegistry} +
 * {@code newInstance()} factory). This runner executes the seven corpus
 * scenarios against that existing API — proving the corpus is satisfiable and
 * establishing the semantic reference the other ports mirror. Assertions are
 * behavioral (type-kind, back-ref identity, field values, list contents,
 * overflow) — not byte-identity.</p>
 *
 * <p>The corpus declares {@code object.value} Person{name:string, age:int,
 * home:Address, tags:Tag[]}, Address{street,city}, Tag{label} in package
 * {@code com::example::om} (see {@code fixtures/object-model-conformance/README.md}).</p>
 */
public class ObjectModelConformanceTest extends SharedRegistryTestBase {

    private static final String PKG = "com::example::om";
    private static final String PERSON_FQN = PKG + "::Person";
    private static final String ADDRESS_FQN = PKG + "::Address";
    private static final String TAG_FQN = PKG + "::Tag";

    // -----------------------------------------------------------------------
    // Corpus loading
    // -----------------------------------------------------------------------

    /**
     * Resolve {@code fixtures/object-model-conformance/} by walking up from the
     * current working directory — the same idiom as the sibling
     * {@code conformance.CorpusRoot}.
     */
    private static Path locateCorpus() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/object-model-conformance");
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        throw new AssertionError(
            "Could not locate fixtures/object-model-conformance/ by walking up from: "
                + Paths.get("").toAbsolutePath());
    }

    /**
     * Load the corpus {@code meta.json} through a FRESH loader (own MetaObject
     * instances). A fresh loader per call matters for the bound-type scenario:
     * {@link MetaObject#getObjectClass()} caches the resolved class per instance,
     * so the registry binding must be installed before the first
     * {@code newInstance()} on a never-before-touched MetaObject.
     */
    private MetaDataLoader loadCorpus(String loaderName) {
        Path meta = locateCorpus().resolve("meta.json");
        String canonical;
        try {
            canonical = new String(Files.readAllBytes(meta), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new AssertionError("Could not read corpus meta.json at " + meta, e);
        }
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "object-model-conformance-" + loaderName);
        loader.init();
        loader.load(List.of(new InMemoryStringSource(canonical, "object-model-conformance/meta.json")));
        return loader;
    }

    @After
    public void resetRegistry() {
        // The bound-type scenario installs a process-global registry; never leak it.
        ObjectClassRegistry.resetGlobal();
    }

    // -----------------------------------------------------------------------
    // Scenario 1 — instantiate-value
    // -----------------------------------------------------------------------

    @Test
    public void scenario1_instantiateValue() {
        MetaDataLoader loader = loadCorpus("s1");
        MetaObject person = loader.getMetaObjectByName(PERSON_FQN);
        assertNotNull("Person MetaObject must load", person);

        Object p = person.newInstance();
        assertTrue("object.value default instance must be the map-backed ValueObject, was "
                + p.getClass().getName(), p instanceof ValueObject);
        assertSame("instance back-reference must be the Person MetaObject",
                person, ((MetaObjectAware) p).getMetaData());
    }

    // -----------------------------------------------------------------------
    // Scenario 2 — scalar-round-trip
    // -----------------------------------------------------------------------

    @Test
    public void scenario2_scalarRoundTrip() {
        MetaDataLoader loader = loadCorpus("s2");
        MetaObject person = loader.getMetaObjectByName(PERSON_FQN);

        Object p = person.newInstance();
        person.getMetaField("name").setString(p, "Ada");
        person.getMetaField("age").setInt(p, 36);

        assertEquals("Ada", person.getMetaField("name").getString(p));
        assertEquals(Integer.valueOf(36), person.getMetaField("age").getInt(p));
    }

    // -----------------------------------------------------------------------
    // Scenario 3 — nested-object
    // -----------------------------------------------------------------------

    @Test
    public void scenario3_nestedObject() {
        MetaDataLoader loader = loadCorpus("s3");
        MetaObject person = loader.getMetaObjectByName(PERSON_FQN);

        MetaObject address = MetaDataUtil.getObjectRef(person.getMetaField("home"));
        assertNotNull("home @objectRef must resolve to the Address MetaObject", address);
        assertEquals(ADDRESS_FQN, address.getName());

        Object addr = address.newInstance();
        address.getMetaField("street").setString(addr, "1 Main");
        address.getMetaField("city").setString(addr, "Anytown");

        Object p = person.newInstance();
        person.getMetaField("home").setObject(p, addr);

        Object got = person.getMetaField("home").getObject(p);
        assertNotNull("home must round-trip", got);
        assertEquals("1 Main", address.getMetaField("street").getString(got));
        assertEquals("Anytown", address.getMetaField("city").getString(got));
        assertSame("nested instance back-reference must be the Address MetaObject",
                address, ((MetaObjectAware) got).getMetaData());
    }

    // -----------------------------------------------------------------------
    // Scenario 4 — array-of-objects
    // -----------------------------------------------------------------------

    @Test
    public void scenario4_arrayOfObjects() {
        MetaDataLoader loader = loadCorpus("s4");
        MetaObject person = loader.getMetaObjectByName(PERSON_FQN);

        MetaObject tag = MetaDataUtil.getObjectRef(person.getMetaField("tags"));
        assertNotNull("tags @objectRef must resolve to the Tag MetaObject", tag);
        assertEquals(TAG_FQN, tag.getName());

        Object t1 = tag.newInstance();
        tag.getMetaField("label").setString(t1, "a");
        Object t2 = tag.newInstance();
        tag.getMetaField("label").setString(t2, "b");

        Object p = person.newInstance();
        person.getMetaField("tags").setObjectArray(p, List.of(t1, t2));

        List<Object> got = person.getMetaField("tags").getObjectArray(p);
        assertNotNull("tags must round-trip", got);
        assertEquals("ordered list of 2", 2, got.size());
        assertEquals("a", tag.getMetaField("label").getString(got.get(0)));
        assertEquals("b", tag.getMetaField("label").getString(got.get(1)));
        assertSame("element 0 back-reference must be the Tag MetaObject",
                tag, ((MetaObjectAware) got.get(0)).getMetaData());
        assertSame("element 1 back-reference must be the Tag MetaObject",
                tag, ((MetaObjectAware) got.get(1)).getMetaData());
    }

    // -----------------------------------------------------------------------
    // Scenario 5 — overflow (an instance may hold more than the declared field set)
    // -----------------------------------------------------------------------

    @Test
    public void scenario5_overflow() {
        MetaDataLoader loader = loadCorpus("s5");
        MetaObject person = loader.getMetaObjectByName(PERSON_FQN);

        ValueObject p = (ValueObject) person.newInstance();
        // The map-backed value object can hold more than the declared field set.
        // object.value defaults to non-extension/strict; the public API to opt an
        // instance into overflow is allowExtensions(true) (no @allowExtensions attr
        // is declared in the corpus, so the production default stays strict).
        p.allowExtensions(true);
        p.put("nickname", "Ace");
        assertEquals("Ace", p.get("nickname"));
    }

    // -----------------------------------------------------------------------
    // Scenario 6 — bound-type
    //
    // Register a port-local "aware" type for the Person FQN in the
    // ObjectClassRegistry, then newInstance(Person) returns THAT type.
    //
    // Scoping (no leak): install a process-global registry holding ONLY the
    // Person binding, exercise it on a FRESH loader (fresh MetaObject instance,
    // so getObjectClass()'s per-instance cache resolves with the binding
    // active), and reset the global registry in @After. Other scenarios use
    // their own fresh loaders + the default (discovered) registry.
    // -----------------------------------------------------------------------

    @Test
    public void scenario6_boundType() {
        ObjectClassRegistry scoped = new ObjectClassRegistry();
        scoped.register(new ObjectClassBindingProvider() {
            @Override
            public Map<String, Class<?>> bindings() {
                return Map.of(PERSON_FQN, PersonPojoFixture.class);
            }
        });
        ObjectClassRegistry.setGlobal(scoped);

        MetaDataLoader loader = loadCorpus("s6");
        MetaObject person = loader.getMetaObjectByName(PERSON_FQN);
        MetaObject address = MetaDataUtil.getObjectRef(person.getMetaField("home"));
        MetaObject tag = MetaDataUtil.getObjectRef(person.getMetaField("tags"));

        Object p = person.newInstance();
        assertTrue("bound FQN must instantiate the registered type, was "
                + p.getClass().getName(), p instanceof PersonPojoFixture);
        assertSame("bound instance back-reference must be the Person MetaObject",
                person, ((MetaObjectAware) p).getMetaData());

        // scalar
        person.getMetaField("name").setString(p, "Ada");
        person.getMetaField("age").setInt(p, 36);
        assertEquals("Ada", person.getMetaField("name").getString(p));
        assertEquals(Integer.valueOf(36), person.getMetaField("age").getInt(p));

        // nested (Address still falls back to ValueObject — only Person is bound)
        Object addr = address.newInstance();
        address.getMetaField("street").setString(addr, "1 Main");
        address.getMetaField("city").setString(addr, "Anytown");
        person.getMetaField("home").setObject(p, addr);
        Object gotHome = person.getMetaField("home").getObject(p);
        assertEquals("1 Main", address.getMetaField("street").getString(gotHome));
        assertEquals("Anytown", address.getMetaField("city").getString(gotHome));

        // array
        Object t1 = tag.newInstance();
        tag.getMetaField("label").setString(t1, "a");
        Object t2 = tag.newInstance();
        tag.getMetaField("label").setString(t2, "b");
        person.getMetaField("tags").setObjectArray(p, List.of(t1, t2));
        List<Object> gotTags = person.getMetaField("tags").getObjectArray(p);
        assertEquals(2, gotTags.size());
        assertEquals("a", tag.getMetaField("label").getString(gotTags.get(0)));
        assertEquals("b", tag.getMetaField("label").getString(gotTags.get(1)));
    }

    // -----------------------------------------------------------------------
    // Scenario 7 — no-binding-fallback
    // -----------------------------------------------------------------------

    @Test
    public void scenario7_noBindingFallback() {
        // Default (discovered) registry — nothing bound for Address.
        MetaDataLoader loader = loadCorpus("s7");
        MetaObject address = loader.getMetaObjectByName(ADDRESS_FQN);
        assertNotNull("Address MetaObject must load", address);

        Object addr = address.newInstance();
        assertTrue("with no binding, Address must fall back to ValueObject, was "
                + addr.getClass().getName(), addr instanceof ValueObject);
    }
}
