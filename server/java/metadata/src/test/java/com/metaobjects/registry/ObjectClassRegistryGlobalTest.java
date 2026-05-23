package com.metaobjects.registry;

import org.junit.After;
import org.junit.Test;
import static org.junit.Assert.*;

/** Tests the process-global holder on ObjectClassRegistry (ADR-0001, Task A2). */
public class ObjectClassRegistryGlobalTest {

    public static class TestClass {}

    @After
    public void resetGlobal() {
        ObjectClassRegistry.resetGlobal();
    }

    @Test
    public void setGlobal_then_global_returns_the_same_instance() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        ObjectClassRegistry.setGlobal(reg);
        assertSame(reg, ObjectClassRegistry.global());
    }

    @Test
    public void resetGlobal_clears_override_so_next_call_returns_fresh_discovered_instance() {
        ObjectClassRegistry custom = new ObjectClassRegistry();
        ObjectClassRegistry.setGlobal(custom);
        ObjectClassRegistry.resetGlobal();

        ObjectClassRegistry fresh = ObjectClassRegistry.global();
        assertNotNull("global() must return a non-null instance after reset", fresh);
        assertNotSame("fresh instance must not be the overridden one", custom, fresh);
    }

    @Test
    public void global_returns_non_null_without_any_explicit_setGlobal() {
        // no setGlobal — lazily discover-populated
        assertNotNull(ObjectClassRegistry.global());
    }
}
