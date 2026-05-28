package com.metaobjects.registry;

import java.util.Collection;

/**
 * Service registry abstraction used by the MetaData type system to discover
 * and register {@link MetaDataTypeProvider} instances.
 *
 * <p>The standard implementation is {@link StandardServiceRegistry}, backed by
 * Java's {@link java.util.ServiceLoader}. Tests may register services directly
 * via {@link #registerService(Class, Object)}. Embedded scenarios that need
 * fully programmatic provider composition (no ServiceLoader, no META-INF/services
 * file) should use the programmatic registration API on
 * {@link MetaDataRegistry} instead.</p>
 *
 * <p>The OSGi runtime variant that lived alongside this abstraction through 6.x
 * was dropped in 7.0.1. Consumers running inside an OSGi container can still
 * wrap MetaObjects' plain JARs with bnd / pax-url.</p>
 *
 * @since 6.0.0
 */
public interface ServiceRegistry {

    /**
     * Get all services of the specified type.
     *
     * @param <T> The service type
     * @param serviceClass The service interface class
     * @return Collection of all registered services of that type
     */
    <T> Collection<T> getServices(Class<T> serviceClass);

    /**
     * Register a service instance.
     *
     * @param <T> The service type
     * @param serviceClass The service interface class
     * @param service The service instance to register
     */
    <T> void registerService(Class<T> serviceClass, T service);

    /**
     * Unregister a service instance.
     *
     * @param <T> The service type
     * @param serviceClass The service interface class
     * @param service The service instance to unregister
     * @return true if the service was found and removed
     */
    <T> boolean unregisterService(Class<T> serviceClass, T service);

    /**
     * Get a human-readable description of this registry.
     *
     * @return Description, e.g. "Java ServiceLoader (TCCL=...)"
     */
    String getDescription();

    /**
     * Close / cleanup the service registry.
     */
    void close();
}
