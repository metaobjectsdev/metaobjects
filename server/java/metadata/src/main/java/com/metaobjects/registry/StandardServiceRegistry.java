package com.metaobjects.registry;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.lang.ref.WeakReference;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * ServiceLoader-backed {@link ServiceRegistry} implementation.
 *
 * <p>Uses Java's {@link ServiceLoader} to discover service providers listed in
 * {@code META-INF/services/} files, with the current thread's context
 * ClassLoader as the discovery root and an inner fallback when the original
 * loader is GC'd. Also supports {@link #registerService(Class, Object)} for
 * tests and runtime service addition.</p>
 *
 * <p>Thread-safe via concurrent collections.</p>
 *
 * @since 6.0.0
 */
public class StandardServiceRegistry implements ServiceRegistry {
    
    private static final Logger log = LoggerFactory.getLogger(StandardServiceRegistry.class);
    
    private final WeakReference<ClassLoader> classLoaderRef;
    private final Map<Class<?>, Set<Object>> manualServices = new ConcurrentHashMap<>();
    private volatile boolean closed = false;
    private final ClassLoader fallbackClassLoader; // Fallback when original is GC'd
    
    /**
     * Create registry with current thread's context class loader
     */
    public StandardServiceRegistry() {
        this(Thread.currentThread().getContextClassLoader());
    }
    
    /**
     * Create registry with specific class loader
     * 
     * @param classLoader ClassLoader to use for service discovery
     */
    public StandardServiceRegistry(ClassLoader classLoader) {
        ClassLoader targetLoader = classLoader != null ? classLoader : getClass().getClassLoader();
        this.classLoaderRef = new WeakReference<>(targetLoader);
        this.fallbackClassLoader = getClass().getClassLoader(); // System/bootstrap fallback
        log.debug("Created StandardServiceRegistry with ClassLoader: {} (WeakReference)", targetLoader);
    }
    
    @Override
    @SuppressWarnings("unchecked")
    public <T> Collection<T> getServices(Class<T> serviceClass) {
        if (closed) {
            throw new IllegalStateException("ServiceRegistry has been closed");
        }
        
        Objects.requireNonNull(serviceClass, "Service class cannot be null");
        
        Set<T> services = new LinkedHashSet<>();
        Set<Class<?>> seenImpls = new HashSet<>();

        // 1. Manually registered services take precedence. A manual registration
        //    is an explicit override, so it wins over an ambiently-discovered
        //    provider of the same concrete class (claim the class first, so the
        //    ServiceLoader pass below skips a same-class discovered instance).
        Set<Object> manual = manualServices.get(serviceClass);
        if (manual != null) {
            synchronized (manual) {
                for (Object service : manual) {
                    if (serviceClass.isInstance(service) && seenImpls.add(service.getClass())) {
                        services.add((T) service);
                        log.debug("Added manual service: {} -> {}",
                                 serviceClass.getSimpleName(), service.getClass().getName());
                    }
                }
            }
        }

        // 2. Discover via ServiceLoader across every candidate classloader AT
        //    DISCOVERY TIME — not just the one captured at construction. A registry
        //    constructed on a thread/phase whose loader cannot enumerate the
        //    provider manifests (e.g. a Spring Boot fat jar, where
        //    META-INF/services entries live in nested BOOT-INF/lib/*.jar visible
        //    only to the LaunchedClassLoader) still finds them via the current
        //    thread-context loader or this class's own loader. Providers are
        //    de-duplicated by concrete class so one visible through several loaders
        //    registers exactly once.
        for (ClassLoader loader : discoveryClassLoaders()) {
            try {
                ServiceLoader<T> serviceLoader = ServiceLoader.load(serviceClass, loader);
                for (T service : serviceLoader) {
                    if (seenImpls.add(service.getClass())) {
                        services.add(service);
                        log.debug("Discovered service via ServiceLoader [{}]: {} -> {}",
                                 loader, serviceClass.getSimpleName(), service.getClass().getName());
                    }
                }
            } catch (ServiceConfigurationError e) {
                // One malformed/unreachable loader must not abort discovery on the others.
                log.warn("Error loading {} services from classloader {}: {}",
                         serviceClass.getName(), loader, e.getMessage(), e);
            }
        }

        log.debug("Found {} services for {}", services.size(), serviceClass.getSimpleName());

        return services;
    }
    
    @Override
    public <T> void registerService(Class<T> serviceClass, T service) {
        if (closed) {
            throw new IllegalStateException("ServiceRegistry has been closed");
        }
        
        Objects.requireNonNull(serviceClass, "Service class cannot be null");
        Objects.requireNonNull(service, "Service instance cannot be null");
        
        if (!serviceClass.isInstance(service)) {
            throw new IllegalArgumentException(
                "Service " + service.getClass().getName() + 
                " does not implement " + serviceClass.getName()
            );
        }
        
        manualServices.computeIfAbsent(serviceClass, k -> ConcurrentHashMap.newKeySet())
                     .add(service);
        
        log.debug("Manually registered service: {} -> {}", 
                 serviceClass.getSimpleName(), service.getClass().getName());
    }
    
    @Override
    public <T> boolean unregisterService(Class<T> serviceClass, T service) {
        if (closed) {
            return false;
        }
        
        Objects.requireNonNull(serviceClass, "Service class cannot be null");
        Objects.requireNonNull(service, "Service instance cannot be null");
        
        Set<Object> services = manualServices.get(serviceClass);
        if (services != null) {
            boolean removed = services.remove(service);
            if (removed) {
                log.debug("Unregistered manual service: {} -> {}", 
                         serviceClass.getSimpleName(), service.getClass().getName());
                
                // Clean up empty sets
                if (services.isEmpty()) {
                    manualServices.remove(serviceClass);
                }
            }
            return removed;
        }
        
        return false;
    }
    
    /**
     * The ordered, de-duplicated set of classloaders to consult for service
     * discovery. Order reflects precedence: the loader captured at construction
     * (preserving prior intent), then the current thread-context loader (the
     * {@code LaunchedClassLoader} in a Spring Boot fat-jar runtime, which can see
     * nested {@code BOOT-INF/lib} service manifests), then this class's own loader
     * (a robust final fallback that, in a fat jar, also resolves to the launcher
     * loader). A {@link LinkedHashSet} both preserves order and collapses loaders
     * that are identical references.
     *
     * @return candidate classloaders for {@link ServiceLoader} discovery
     */
    private Collection<ClassLoader> discoveryClassLoaders() {
        Set<ClassLoader> loaders = new LinkedHashSet<>();
        loaders.add(getActiveClassLoader());
        loaders.add(Thread.currentThread().getContextClassLoader());
        loaders.add(getClass().getClassLoader());
        loaders.remove(null);
        return loaders;
    }

    /**
     * Get the active ClassLoader, with fallback if original was GC'd
     *
     * @return Active ClassLoader (original or fallback)
     */
    private ClassLoader getActiveClassLoader() {
        ClassLoader loader = classLoaderRef.get();
        if (loader == null) {
            log.debug("Original ClassLoader was garbage collected, using fallback: {}", fallbackClassLoader);
            return fallbackClassLoader;
        }
        return loader;
    }
    
    /**
     * Check if the original ClassLoader is still available
     * 
     * @return true if original ClassLoader has not been GC'd
     */
    public boolean isOriginalClassLoaderAvailable() {
        return classLoaderRef.get() != null;
    }
    
    /**
     * Get information about ClassLoader status
     * 
     * @return Status description
     */
    public String getClassLoaderStatus() {
        ClassLoader original = classLoaderRef.get();
        if (original != null) {
            return "Original ClassLoader active: " + original;
        } else {
            return "Original ClassLoader GC'd, using fallback: " + fallbackClassLoader;
        }
    }
    
    @Override
    public String getDescription() {
        return "Java ServiceLoader (" + getClassLoaderStatus() + ")";
    }
    
    @Override
    public void close() {
        if (!closed) {
            log.debug("Closing StandardServiceRegistry");
            manualServices.clear();
            closed = true;
        }
    }
    
    /**
     * Get statistics about registered services
     * 
     * @return Map of service class to count of manually registered instances
     */
    public Map<String, Integer> getServiceStats() {
        Map<String, Integer> stats = new HashMap<>();
        manualServices.forEach((serviceClass, services) -> 
            stats.put(serviceClass.getSimpleName(), services.size())
        );
        return stats;
    }
    
    /**
     * Check if the registry has been closed
     * 
     * @return true if closed
     */
    public boolean isClosed() {
        return closed;
    }
}