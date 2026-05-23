package com.metaobjects.object;

import com.metaobjects.object.pojo.PojoMetaObject;
import com.metaobjects.object.mapped.MappedMetaObject;
import com.metaobjects.object.proxy.ProxyMetaObject;
import com.metaobjects.registry.ObjectClassRegistry;

/**
 * Resolves the Java <em>representation</em> class (Pojo/Mapped/Proxy) for an object node,
 * per ADR-0005:
 * <ol>
 *   <li>{@code @object} FQN (inline override) wins if present.</li>
 *   <li>Binding registry ({@link ObjectClassRegistry}) is consulted by canonical FQN.</li>
 *   <li>Default: nothing bound → Map-backed value-object ({@link MappedMetaObject}).</li>
 * </ol>
 * Once a bound class is located, the representation is chosen by inspecting the class:
 * a concrete class maps to {@link PojoMetaObject} (reflection-backed); an interface maps
 * to {@link ProxyMetaObject} (dynamic proxy); no binding maps to {@link MappedMetaObject}.
 *
 * <p>The chosen representation class carries the <em>semantic</em> subtype (entity/value)
 * when instantiated — "pojo" is never used as a semantic subtype.</p>
 */
public final class ObjectRepresentationResolver {

    private final ObjectClassRegistry registry;
    private final ClassLoader classLoader;

    public ObjectRepresentationResolver(ObjectClassRegistry registry, ClassLoader classLoader) {
        this.registry = registry;
        this.classLoader = classLoader;
    }

    /**
     * Resolves the representation class for an object node.
     *
     * @param fqn        the object's canonical FQN ({@code "pkg::Name"})
     * @param objectAttr the value of the {@code @object} attribute (a Java class FQN), or null
     * @return the representation class — one of {@link PojoMetaObject}, {@link ProxyMetaObject},
     *         or {@link MappedMetaObject}
     */
    public Class<? extends MetaObject> resolve(String fqn, String objectAttr) {
        Class<?> bound = resolveBoundClass(fqn, objectAttr);
        if (bound == null) return MappedMetaObject.class;          // unbound -> Map-backed
        return bound.isInterface() ? ProxyMetaObject.class         // interface -> proxy
                                   : PojoMetaObject.class;         // concrete  -> reflection
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    private Class<?> resolveBoundClass(String fqn, String objectAttr) {
        if (objectAttr != null && !objectAttr.isEmpty()) {         // inline @object FQN wins
            try {
                return Class.forName(objectAttr, false, classLoader);
            } catch (ClassNotFoundException e) {
                throw new IllegalStateException(
                    "@object class not found: " + objectAttr + " (for " + fqn + ")", e);
            }
        }
        return registry == null ? null : registry.resolve(fqn);    // binding registry, or null
    }
}
