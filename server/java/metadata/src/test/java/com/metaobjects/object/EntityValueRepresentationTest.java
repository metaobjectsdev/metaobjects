package com.metaobjects.object;

import com.metaobjects.MetaData;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataLoaderTestBase;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
import org.junit.Test;

import java.util.Collections;

import static org.junit.Assert.*;

/**
 * ADR-0005 (post-resolver): the JSON loader registers {@code object.entity} / {@code object.value}
 * as semantic subtypes backed by {@link EntityMetaObject} / {@link ValueMetaObject}. The generic
 * registry path constructs those classes via their public 1-arg ctor (which stamps the subType),
 * so the node's {@code subType} is {@code "entity"}/{@code "value"} and its MetaObject class is the
 * matching representation. Unbound objects instantiate the {@link ValueObject} backing by default.
 */
public class EntityValueRepresentationTest extends MetaDataLoaderTestBase {

    private static final String FIXTURE =
        "model:resource:com/metaobjects/object/meta.entityvalue.json";

    private static final String PROGRAM_FQN = "myapp::commerce::Program";
    private static final String MONEY_FQN   = "myapp::commerce::Money";

    @After
    public void tearDownBindings() {
        // getObjectClass() reads ObjectClassRegistry.global(); reset so any stray binding
        // cannot leak into the next test.
        ObjectClassRegistry.resetGlobal();
    }

    /** Resolve an object node from the loaded root (bypasses loader checkState). */
    private MetaData objectNode(MetaDataLoader loader, String fqn) {
        return loader.getRoot().getChildOfType(MetaObject.TYPE_OBJECT, fqn);
    }

    // -----------------------------------------------------------------------
    // object.entity → EntityMetaObject (subType "entity");
    // object.value  → ValueMetaObject  (subType "value").
    // -----------------------------------------------------------------------

    @Test
    public void entity_is_EntityMetaObject_and_value_is_ValueMetaObject() throws Exception {
        MetaDataLoader loader = initLoader(Collections.singletonList(URIHelper.toURI(FIXTURE)));

        MetaData program = objectNode(loader, PROGRAM_FQN);
        assertNotNull("Program should load", program);
        assertEquals("Program subType is the semantic 'entity'", "entity", program.getSubType());
        assertEquals("object.entity -> EntityMetaObject",
                EntityMetaObject.class, program.getClass());

        MetaData money = objectNode(loader, MONEY_FQN);
        assertNotNull("Money should load", money);
        assertEquals("Money subType is the semantic 'value'", "value", money.getSubType());
        assertEquals("object.value -> ValueMetaObject",
                ValueMetaObject.class, money.getClass());
    }

    // -----------------------------------------------------------------------
    // Unbound entity/value default their backing runtime object to ValueObject.
    // -----------------------------------------------------------------------

    @Test
    public void unbound_entity_and_value_newInstance_to_value_object() throws Exception {
        // No binding registered: fresh empty global registry so resolve() returns null and
        // getObjectClass() falls through to the default ValueObject backing.
        ObjectClassRegistry.setGlobal(new ObjectClassRegistry());

        MetaDataLoader loader = initLoader(Collections.singletonList(URIHelper.toURI(FIXTURE)));

        MetaObject program = (MetaObject) objectNode(loader, PROGRAM_FQN);
        Object programInstance = program.newInstance();
        assertTrue("unbound entity -> ValueObject backing, got " + programInstance.getClass(),
                programInstance instanceof ValueObject);

        MetaObject money = (MetaObject) objectNode(loader, MONEY_FQN);
        Object moneyInstance = money.newInstance();
        assertTrue("unbound value -> ValueObject backing, got " + moneyInstance.getClass(),
                moneyInstance instanceof ValueObject);
    }

    // -----------------------------------------------------------------------
    // Canonical serialization keeps the semantic subtype and never leaks a
    // representation subtype (pojo/map/proxy), a javaRuntime marker, or the
    // Java-only @objectAdapter hint.
    // -----------------------------------------------------------------------

    @Test
    public void canonical_serialization_preserves_semantic_subtypes() throws Exception {
        MetaDataLoader loader = initLoader(Collections.singletonList(URIHelper.toURI(FIXTURE)));

        String programJson = CanonicalJsonSerializer.canonicalSerialize(objectNode(loader, PROGRAM_FQN));
        String moneyJson   = CanonicalJsonSerializer.canonicalSerialize(objectNode(loader, MONEY_FQN));

        assertTrue("Program serializes as object.entity", programJson.contains("object.entity"));
        assertTrue("Money serializes as object.value", moneyJson.contains("object.value"));

        for (String json : new String[]{ programJson, moneyJson }) {
            assertFalse("must not leak object.pojo", json.contains("object.pojo"));
            assertFalse("must not leak object.map", json.contains("object.map"));
            assertFalse("must not leak object.proxy", json.contains("object.proxy"));
            assertFalse("must not leak a javaRuntime marker", json.contains("javaRuntime"));
            assertFalse("must not leak the @objectAdapter hint", json.contains("objectAdapter"));
        }
    }
}
