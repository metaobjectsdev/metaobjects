package com.metaobjects.registry;

import org.junit.Test;
import static org.junit.Assert.*;

public class ObjectClassRegistryTest {

    public static class Disposition {}
    public static class OtherDisposition {}

    public static class TestProvider implements ObjectClassBindingProvider {
        @Override public java.util.Map<String, Class<?>> bindings() {
            java.util.Map<String, Class<?>> m = new java.util.HashMap<>();
            m.put("myapp::commerce::Disposition", Disposition.class);
            return m;
        }
    }

    @Test
    public void resolves_a_registered_fqn_to_its_class() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(new TestProvider());
        assertEquals(Disposition.class, reg.resolve("myapp::commerce::Disposition"));
    }

    @Test
    public void returns_null_for_unbound_fqn() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        assertNull(reg.resolve("myapp::commerce::Unbound"));
    }

    @Test
    public void later_provider_does_not_silently_override_a_different_class_for_same_fqn() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> java.util.Map.of("a::B", Disposition.class));
        try {
            reg.register(() -> java.util.Map.of("a::B", OtherDisposition.class));
            fail("expected a conflict to be rejected");
        } catch (IllegalStateException expected) { /* domain-sliced providers must not clash */ }
    }
}
