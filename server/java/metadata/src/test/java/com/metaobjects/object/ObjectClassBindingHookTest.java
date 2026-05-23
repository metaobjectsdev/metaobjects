package com.metaobjects.object;

import com.metaobjects.field.MetaField;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
import org.junit.Test;

import static org.junit.Assert.*;

/**
 * Verifies that MetaObject.getObjectClass() consults the global ObjectClassRegistry
 * as a fallback between the @object attr and the name-convention class lookup (ADR-0001,
 * Task A2).
 *
 * <p>Exercises the hook on the base {@link MetaObject#getObjectClass()} via a minimal
 * local subclass. The concrete representations ({@code EntityMetaObject}/{@code ValueMetaObject})
 * override {@code getObjectClass()} with a default-class fallback, so they bypass this hook;
 * this test deliberately targets the base behavior, not a representation impl.</p>
 */
public class ObjectClassBindingHookTest {

    /** A trivial domain class used as the bound target. */
    public static class Widget {
        public Widget() {}
    }

    /**
     * Minimal {@link MetaObject} that does not override {@code getObjectClass()},
     * so it inherits the base-class registry-fallback hook under test.
     */
    static final class BindingProbeMetaObject extends MetaObject {
        BindingProbeMetaObject(String name) { super(MetaObject.SUBTYPE_BASE, name); }
        @Override public boolean produces(Object obj) { return false; }
        @Override public Object getValue(MetaField f, Object obj) { return null; }
        @Override public void setValue(MetaField f, Object obj, Object value) { }
    }

    @After
    public void resetGlobal() {
        ObjectClassRegistry.resetGlobal();
    }

    // -----------------------------------------------------------------------
    // Case 1: FQN is bound in the registry → getObjectClass() returns bound class
    // -----------------------------------------------------------------------

    @Test
    public void getObjectClass_returns_registry_bound_class_when_no_object_attr() throws Exception {
        // Arrange: install a registry that binds the test FQN
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> java.util.Map.of("bindtest::Widget", Widget.class));
        ObjectClassRegistry.setGlobal(reg);

        // Fresh MetaObject each time to avoid cache masking
        BindingProbeMetaObject mo = new BindingProbeMetaObject("bindtest::Widget");

        // Act
        Class<?> resolved = mo.getObjectClass();

        // Assert
        assertSame("registry binding should be returned for a MetaObject with no @object attr",
                Widget.class, resolved);
    }

    @Test
    public void newInstance_returns_instance_of_registry_bound_class() throws Exception {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> java.util.Map.of("bindtest::Widget", Widget.class));
        ObjectClassRegistry.setGlobal(reg);

        BindingProbeMetaObject mo = new BindingProbeMetaObject("bindtest::Widget");

        Object instance = mo.newInstance();

        assertNotNull(instance);
        assertTrue("newInstance() must produce an instance of the bound class",
                instance instanceof Widget);
    }

    // -----------------------------------------------------------------------
    // Case 2: No binding → prior behavior (InvalidMetaDataException / ClassNotFoundException)
    // -----------------------------------------------------------------------

    @Test
    public void getObjectClass_falls_back_to_convention_when_no_registry_binding() {
        // Empty registry — nothing bound
        ObjectClassRegistry.setGlobal(new ObjectClassRegistry());

        // FQN that maps to no class via convention ("unbound::NoSuchClass" → "unbound.NoSuchClass")
        BindingProbeMetaObject mo = new BindingProbeMetaObject("unbound::NoSuchClass");

        // Neither @object attr, registry binding, nor convention can resolve the class →
        // createClassFromMetaDataName(true) throws InvalidMetaDataException.
        assertThrows(com.metaobjects.InvalidMetaDataException.class, mo::getObjectClass);
    }
}
