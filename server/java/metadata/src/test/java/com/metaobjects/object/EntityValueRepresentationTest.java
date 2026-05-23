package com.metaobjects.object;

import com.metaobjects.MetaData;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataLoaderTestBase;
import com.metaobjects.loader.parser.json.CanonicalJsonParser;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.object.mapped.MappedMetaObject;
import com.metaobjects.object.pojo.PojoMetaObject;
import com.metaobjects.registry.ObjectClassBindingProvider;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Map;

import static org.junit.Assert.*;

/**
 * Task 2 (ADR-0005): the JSON loader registers {@code object.entity} / {@code object.value}
 * as semantic subtypes and instantiates the resolver-chosen <em>representation</em> class
 * (Pojo/Mapped/Proxy) for those nodes — with the node's {@code subType} remaining
 * {@code "entity"}/{@code "value"} (never {@code "pojo"}/{@code "map"}/{@code "proxy"}).
 */
public class EntityValueRepresentationTest extends MetaDataLoaderTestBase {

    private static final String FIXTURE =
        "model:resource:com/metaobjects/object/meta.entityvalue.json";

    private static final String PROGRAM_FQN = "myapp::commerce::Program";
    private static final String MONEY_FQN   = "myapp::commerce::Money";

    /** A concrete (non-interface) class — resolves to a Pojo representation when bound. */
    public static class ProgramImpl {
        private long id;
        public long getId() { return id; }
        public void setId(long id) { this.id = id; }
    }

    /** Binds Program's FQN to a concrete class so the resolver picks PojoMetaObject. */
    public static class ProgramBindingProvider implements ObjectClassBindingProvider {
        @Override public Map<String, Class<?>> bindings() {
            return Map.of(PROGRAM_FQN, ProgramImpl.class);
        }
    }

    @After
    public void tearDownBindings() {
        // The parser reads ObjectClassRegistry.global() at node-construction time; reset so a
        // test that registered a binding cannot leak into the next test's fresh load.
        ObjectClassRegistry.resetGlobal();
    }

    /** Resolve an object node from the loaded root (bypasses loader checkState). */
    private MetaData objectNode(MetaDataLoader loader, String fqn) {
        return loader.getRoot().getChildOfType(MetaObject.TYPE_OBJECT, fqn);
    }

    // -----------------------------------------------------------------------
    // 1 + 2 + 3: load succeeds; unbound entity/value default to MappedMetaObject;
    //            subType stays entity/value.
    // -----------------------------------------------------------------------

    @Test
    public void unbound_entity_and_value_default_to_mapped_with_semantic_subtype() throws Exception {
        // No binding registered: install an empty global registry so resolve() returns null.
        ObjectClassRegistry.setGlobal(new ObjectClassRegistry());

        MetaDataLoader loader = initLoader(Collections.singletonList(URIHelper.toURI(FIXTURE)));

        MetaData program = objectNode(loader, PROGRAM_FQN);
        assertNotNull("Program should load", program);
        assertEquals("Program subType is the semantic 'entity'", "entity", program.getSubType());
        assertEquals("unbound entity -> Map-backed representation",
                MappedMetaObject.class, program.getClass());

        MetaData money = objectNode(loader, MONEY_FQN);
        assertNotNull("Money should load", money);
        assertEquals("Money subType is the semantic 'value'", "value", money.getSubType());
        assertEquals("unbound value -> Map-backed representation",
                MappedMetaObject.class, money.getClass());
    }

    // -----------------------------------------------------------------------
    // 4: binding case — a registered concrete binding makes the representation a Pojo,
    //    while subType stays "entity".
    // -----------------------------------------------------------------------

    @Test
    public void bound_entity_resolves_to_pojo_representation_with_semantic_subtype() throws Exception {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(new ProgramBindingProvider());
        ObjectClassRegistry.setGlobal(reg);

        MetaDataLoader loader = initLoader(Collections.singletonList(URIHelper.toURI(FIXTURE)));

        MetaData program = objectNode(loader, PROGRAM_FQN);
        assertEquals("bound concrete class -> Pojo representation",
                PojoMetaObject.class, program.getClass());
        assertEquals("subType is still the semantic 'entity'", "entity", program.getSubType());

        // Money is still unbound -> Mapped.
        MetaData money = objectNode(loader, MONEY_FQN);
        assertEquals("unbound value stays Map-backed",
                MappedMetaObject.class, money.getClass());
        assertEquals("value", money.getSubType());
    }

    // -----------------------------------------------------------------------
    // 5: @object override — an inline @object FQN wins over (here, absent) registry binding.
    // -----------------------------------------------------------------------

    @Test
    public void object_attr_override_resolves_to_pojo_without_a_registry_binding() {
        // Empty registry: no binding for Widget. @object alone must drive the resolution.
        ObjectClassRegistry.setGlobal(new ObjectClassRegistry());

        String canonical =
            "{ \"metadata.root\": { \"package\": \"myapp::commerce\", \"children\": [" +
            "  { \"object.entity\": { \"name\": \"Widget\", \"@object\": \"" +
                    ProgramImpl.class.getName() + "\", \"children\": [" +
            "    { \"field.long\": { \"name\": \"id\" } }" +
            "  ] } }" +
            "] } }";

        MetaDataLoader loader = createTestLoader("EntityValueObjectAttr", Collections.emptyList());
        CanonicalJsonParser parser = new CanonicalJsonParser(loader, "widget.json");
        parser.loadFromStream(new ByteArrayInputStream(canonical.getBytes(StandardCharsets.UTF_8)));

        MetaData widget = objectNode(loader, "myapp::commerce::Widget");
        assertNotNull("Widget should load", widget);
        assertEquals("@object FQN (concrete class) -> Pojo representation",
                PojoMetaObject.class, widget.getClass());
        assertEquals("subType is still the semantic 'entity'", "entity", widget.getSubType());
    }

    // -----------------------------------------------------------------------
    // 6: canonical serialization preserves the semantic subtype and never leaks the
    //    representation subtype (pojo/map/proxy) or a javaRuntime marker.
    // -----------------------------------------------------------------------

    @Test
    public void canonical_serialization_preserves_semantic_subtypes() throws Exception {
        ObjectClassRegistry.setGlobal(new ObjectClassRegistry());

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
        }
    }
}
