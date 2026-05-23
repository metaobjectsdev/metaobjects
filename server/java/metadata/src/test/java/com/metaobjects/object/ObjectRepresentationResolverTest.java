package com.metaobjects.object;

import com.metaobjects.object.pojo.PojoMetaObject;
import com.metaobjects.object.mapped.MappedMetaObject;
import com.metaobjects.object.proxy.ProxyMetaObject;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.Test;
import static org.junit.Assert.*;

public class ObjectRepresentationResolverTest {

    public static class ConcretePojo {}            // stand-in generated concrete class
    public interface SomeIface {}                  // stand-in interface

    private ObjectRepresentationResolver resolverWith(ObjectClassRegistry reg) {
        return new ObjectRepresentationResolver(reg, getClass().getClassLoader());
    }

    @Test public void unbound_defaults_to_mapped() {
        ObjectClassRegistry reg = new ObjectClassRegistry();   // empty
        Class<?> rep = resolverWith(reg).resolve("myapp::commerce::Program", null);
        assertEquals(MappedMetaObject.class, rep);
    }

    @Test public void concrete_class_in_registry_resolves_to_pojo() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> java.util.Map.of("myapp::commerce::Program", ConcretePojo.class));
        assertEquals(PojoMetaObject.class, resolverWith(reg).resolve("myapp::commerce::Program", null));
    }

    @Test public void interface_in_registry_resolves_to_proxy() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> java.util.Map.of("myapp::commerce::Program", SomeIface.class));
        assertEquals(ProxyMetaObject.class, resolverWith(reg).resolve("myapp::commerce::Program", null));
    }

    @Test public void objectAttr_fqn_overrides_registry() {
        ObjectClassRegistry reg = new ObjectClassRegistry();   // empty registry
        // @object names a concrete class FQN -> Pojo, even though registry is empty
        Class<?> rep = resolverWith(reg).resolve("myapp::commerce::Program",
            ConcretePojo.class.getName());
        assertEquals(PojoMetaObject.class, rep);
    }

    @Test public void objectAttr_interface_fqn_resolves_to_proxy() {
        Class<?> rep = resolverWith(new ObjectClassRegistry()).resolve("x::Y", SomeIface.class.getName());
        assertEquals(ProxyMetaObject.class, rep);
    }
}
