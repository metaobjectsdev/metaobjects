package com.metaobjects.object;

import com.metaobjects.MetaData;
import com.metaobjects.MetaDataException;
import com.metaobjects.field.MetaField;
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
 * Pins the three behaviours of the {@code @objectAdapter} hook on
 * {@code object.entity} / {@code object.value} nodes (ADR-0005).
 *
 * <ol>
 *   <li>Adapter present → all access delegated to the adapter.</li>
 *   <li>Adapter absent  → built-in hybrid (unbound → {@link ValueObject}).</li>
 *   <li>Bad FQN         → {@link MetaDataException} thrown on first access.</li>
 * </ol>
 */
public class ObjectAdapterHookTest extends MetaDataLoaderTestBase {

    // -----------------------------------------------------------------------
    // In-test adapter — records delegation via a sentinel return value.
    // Must be public static so Class.forName() can instantiate it.
    // -----------------------------------------------------------------------

    public static class SentinelAdapter implements ObjectAdapter {
        public static final String SENTINEL = "from-adapter";

        @Override
        public Object newInstance(MetaObject mo) {
            return SENTINEL;
        }

        @Override
        public Object getValue(MetaObject mo, MetaField f, Object obj) {
            return SENTINEL;
        }

        @Override
        public void setValue(MetaObject mo, MetaField f, Object obj, Object value) {
            // no-op
        }
    }

    // -----------------------------------------------------------------------

    private static final String FIXTURE =
        "model:resource:com/metaobjects/object/meta.objectadapter.json";

    private static final String WIDGET_FQN = "test::adapter::Widget";
    private static final String MONEY_FQN  = "test::adapter::Money";
    private static final String BROKEN_FQN = "test::adapter::Broken";

    @After
    public void tearDownBindings() {
        ObjectClassRegistry.resetGlobal();
    }

    /** Resolve an object node from the loaded root. */
    private MetaObject objectNode(MetaDataLoader loader, String fqn) {
        MetaData node = loader.getRoot().getChildOfType(MetaObject.TYPE_OBJECT, fqn);
        assertNotNull("Expected object node for FQN: " + fqn, node);
        return (MetaObject) node;
    }

    // -----------------------------------------------------------------------
    // Test 1: adapter present → newInstance() returns the sentinel value.
    // -----------------------------------------------------------------------

    @Test
    public void adapter_present_delegates() throws Exception {
        MetaDataLoader loader = initLoader(Collections.singletonList(URIHelper.toURI(FIXTURE)));

        MetaObject widget = objectNode(loader, WIDGET_FQN);
        Object result = widget.newInstance();

        assertEquals("@objectAdapter must delegate newInstance() to the adapter",
                SentinelAdapter.SENTINEL, result);
    }

    // -----------------------------------------------------------------------
    // Test 2: adapter absent → built-in hybrid produces ValueObject.
    // -----------------------------------------------------------------------

    @Test
    public void adapter_absent_uses_builtin() throws Exception {
        // Empty registry so no name-convention class is found; falls through to
        // the default ValueObject backing (matches EntityValueRepresentationTest pattern).
        ObjectClassRegistry.setGlobal(new ObjectClassRegistry());

        MetaDataLoader loader = initLoader(Collections.singletonList(URIHelper.toURI(FIXTURE)));

        MetaObject money = objectNode(loader, MONEY_FQN);
        Object result = money.newInstance();

        assertTrue("Absent @objectAdapter must use the built-in ValueObject backing; got "
                + result.getClass().getName(),
                result instanceof ValueObject);
    }

    // -----------------------------------------------------------------------
    // Test 3: bad FQN → MetaDataException thrown on first access.
    // -----------------------------------------------------------------------

    @Test
    public void adapter_bad_fqn_throws() throws Exception {
        MetaDataLoader loader = initLoader(Collections.singletonList(URIHelper.toURI(FIXTURE)));

        MetaObject broken = objectNode(loader, BROKEN_FQN);

        try {
            broken.newInstance();
            fail("Expected MetaDataException for unresolvable @objectAdapter FQN");
        } catch (MetaDataException e) {
            // expected — message should contain the bad FQN for diagnostics
            assertTrue("Exception message should include the bad FQN",
                    e.getMessage().contains("com.does.not.Exist"));
        }
    }
}
