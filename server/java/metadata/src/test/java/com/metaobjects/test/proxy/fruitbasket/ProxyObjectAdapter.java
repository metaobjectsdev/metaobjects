package com.metaobjects.test.proxy.fruitbasket;

import com.metaobjects.MetaDataException;
import com.metaobjects.field.MetaField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.ObjectAdapter;
import com.metaobjects.object.proxy.ProxyObject;
import com.metaobjects.object.proxy.ProxyObjectHandler;

import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/**
 * Reference {@link ObjectAdapter} that backs an {@code object.entity} whose
 * {@code @object} names an interface with a dynamic {@link Proxy}.
 *
 * <p>This is the example proving the Java-only {@code @objectAdapter} extension
 * seam (ADR-0005): dynamic-proxy object support is no longer a core metamodel
 * concern (the per-node representation resolver was removed). Instead, a fixture
 * that wants proxy-backed instances points its object nodes at this class via
 * {@code "@objectAdapter": "com.metaobjects.test.proxy.fruitbasket.ProxyObjectAdapter"}.
 * It reuses the runtime proxy infrastructure
 * ({@link ProxyObject} + {@link ProxyObjectHandler}) but selects/instantiates it
 * here in test/example scope rather than in the core loader pipeline.</p>
 *
 * <p>Ports the behavior of the (now-demoted) {@code ProxyMetaObject.newInstance()}:
 * resolve the interface from {@code @object}, wrap a backing {@link ProxyObject}
 * (constructed with the {@link MetaObject}) in a {@link Proxy}, then apply default
 * values. Value access is plain interface getter/setter reflection on the proxy —
 * the proxy's {@link ProxyObjectHandler} intercepts those calls and stores into the
 * backing object's value map.</p>
 */
public class ProxyObjectAdapter implements ObjectAdapter {

    @Override
    public Object newInstance(MetaObject mo) {

        Class<?> iface;
        try {
            iface = mo.getObjectClass();
        } catch (ClassNotFoundException e) {
            throw new MetaDataException(
                    "@objectAdapter ProxyObjectAdapter could not resolve the @object interface for MetaObject ["
                            + mo.getName() + "]: " + e.getMessage(), e);
        }

        if (!iface.isInterface()) {
            throw new MetaDataException(
                    "@objectAdapter ProxyObjectAdapter requires @object to name an interface, but ["
                            + iface.getName() + "] is not an interface (MetaObject [" + mo.getName() + "])");
        }

        // Backing object holds the value map; the fixtures do not use @proxyObject,
        // so the default ProxyObject(MetaObject) backing is sufficient.
        ProxyObject backing = new ProxyObject(mo);

        Object proxy = Proxy.newProxyInstance(
                ProxyObject.class.getClassLoader(),
                new Class[]{iface},
                new ProxyObjectHandler(backing));

        // Mirror ProxyMetaObject.newInstance(): apply declared default values.
        mo.setDefaultValues(proxy);

        return proxy;
    }

    @Override
    public Object getValue(MetaObject mo, MetaField f, Object obj) {
        Method getter = findGetter(obj.getClass(), f);
        try {
            return getter.invoke(obj);
        } catch (Exception e) {
            throw new MetaDataException("Could not read field [" + f.getName() + "] via proxy getter ["
                    + getter.getName() + "] on [" + obj.getClass() + "]: " + e.getMessage(), e);
        }
    }

    @Override
    public void setValue(MetaObject mo, MetaField f, Object obj, Object value) {
        Method setter = findSetter(obj.getClass(), f);
        try {
            setter.invoke(obj, value);
        } catch (Exception e) {
            throw new MetaDataException("Could not write field [" + f.getName() + "] via proxy setter ["
                    + setter.getName() + "] on [" + obj.getClass() + "]: " + e.getMessage(), e);
        }
    }

    /** {@code get<Field>} / {@code is<Field>} — mirrors PojoMetaObject.findGetterName capitalization. */
    private Method findGetter(Class<?> objClass, MetaField f) {
        try {
            return objClass.getMethod("get" + capitalize(f.getName()));
        } catch (NoSuchMethodException e) {
            try {
                return objClass.getMethod("is" + capitalize(f.getName()));
            } catch (NoSuchMethodException e2) {
                throw new MetaDataException("No getter [(get/is)" + capitalize(f.getName())
                        + "] on proxy interface [" + objClass.getName() + "] for field [" + f.getName() + "]");
            }
        }
    }

    /** {@code set<Field>} — found by name, single argument (the proxy handler dispatches by name). */
    private Method findSetter(Class<?> objClass, MetaField f) {
        String name = "set" + capitalize(f.getName());
        for (Method m : objClass.getMethods()) {
            if (m.getName().equals(name) && m.getParameterCount() == 1) {
                return m;
            }
        }
        throw new MetaDataException("No single-argument setter [" + name + "] on proxy interface ["
                + objClass.getName() + "] for field [" + f.getName() + "]");
    }

    private static String capitalize(String name) {
        if (name == null || name.isEmpty()) return name;
        return Character.toUpperCase(name.charAt(0)) + name.substring(1);
    }
}
