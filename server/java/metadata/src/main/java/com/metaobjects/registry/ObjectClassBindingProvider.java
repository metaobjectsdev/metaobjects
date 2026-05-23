package com.metaobjects.registry;

import java.util.Map;

/** SPI: a domain slice's contribution of FQN -> Java class bindings (ADR-0001).
 *  Implementations are discovered via ServiceLoader; codegen emits one per package. */
@FunctionalInterface
public interface ObjectClassBindingProvider {
    /** Canonical metadata FQN ("pkg::Name") -> the concrete Java class to instantiate. */
    Map<String, Class<?>> bindings();
}
