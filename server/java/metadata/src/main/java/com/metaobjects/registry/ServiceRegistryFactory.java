package com.metaobjects.registry;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Factory for the default {@link ServiceRegistry} singleton.
 *
 * <p>Returns a {@link StandardServiceRegistry} backed by Java's
 * {@link java.util.ServiceLoader}. The OSGi runtime variant that lived here
 * through 6.x was dropped in 7.0.1 — see MIGRATION.md for the rationale.
 * Consumers running inside an OSGi container can still wrap our plain JARs
 * with bnd / pax-url; we just no longer ship a native OSGi registry.</p>
 *
 * @since 6.0.0
 */
public final class ServiceRegistryFactory {

    private static final Logger log = LoggerFactory.getLogger(ServiceRegistryFactory.class);

    private static volatile ServiceRegistry defaultInstance;
    private static final Object LOCK = new Object();

    private ServiceRegistryFactory() { }

    /**
     * Get the default ServiceRegistry instance (singleton).
     *
     * @return ServiceRegistry appropriate for the current environment
     */
    public static ServiceRegistry getDefault() {
        if (defaultInstance == null) {
            synchronized (LOCK) {
                if (defaultInstance == null) {
                    defaultInstance = create();
                }
            }
        }
        return defaultInstance;
    }

    /**
     * Create a new {@link StandardServiceRegistry} using the current thread's
     * context ClassLoader for discovery.
     *
     * @return ServiceRegistry instance
     */
    public static ServiceRegistry create() {
        log.debug("Creating StandardServiceRegistry");
        return new StandardServiceRegistry();
    }

    /**
     * Create a {@link StandardServiceRegistry} with a specific ClassLoader.
     *
     * @param classLoader ClassLoader to use for service discovery
     * @return StandardServiceRegistry instance
     */
    public static ServiceRegistry create(ClassLoader classLoader) {
        log.debug("Creating StandardServiceRegistry with specific ClassLoader: {}", classLoader);
        return new StandardServiceRegistry(classLoader);
    }

    /**
     * Reset the default instance (primarily for testing).
     */
    public static void resetDefault() {
        synchronized (LOCK) {
            if (defaultInstance != null) {
                defaultInstance.close();
                defaultInstance = null;
            }
        }
    }

    /**
     * Get information about the current environment.
     *
     * @return Environment description
     */
    public static String getEnvironmentInfo() {
        ClassLoader contextLoader = Thread.currentThread().getContextClassLoader();
        return "ServiceRegistry: StandardServiceRegistry, Context ClassLoader: " + contextLoader;
    }
}
