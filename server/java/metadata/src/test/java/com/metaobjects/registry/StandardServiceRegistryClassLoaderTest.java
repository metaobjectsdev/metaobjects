package com.metaobjects.registry;

import com.metaobjects.core.CoreTypeMetaDataProvider;
import org.junit.Test;

import java.util.Collection;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Regression coverage for the Spring Boot fat-jar type-provider bootstrap failure.
 *
 * <p>{@link StandardServiceRegistry} captures a {@link ClassLoader} at construction
 * time (the thread-context loader, via {@link ServiceRegistryFactory#getDefault()}).
 * In a Spring Boot fat jar the {@code META-INF/services/} provider manifests live in
 * nested {@code BOOT-INF/lib/*.jar} entries that are only visible to the
 * {@code LaunchedClassLoader}. If the registry singleton is first constructed on a
 * thread/phase whose captured loader cannot enumerate those nested manifests,
 * {@link java.util.ServiceLoader} discovers ZERO providers — so
 * {@code MetaDataTypeProvider.registerTypes} never runs, the type registry stays
 * empty, and a bare {@code metadata:} YAML root fails to desugar
 * ("no default subType for type 'metadata'").
 *
 * <p>These tests reproduce that condition in-process by constructing the registry
 * with a loader that is deliberately blind to the provider manifests (the JDK
 * platform loader, which cannot see the application classpath). Discovery must
 * still succeed by consulting the current thread-context loader (and this class's
 * own loader) <em>at discovery time</em> rather than relying solely on the loader
 * captured at construction.
 */
public class StandardServiceRegistryClassLoaderTest {

    private static Set<String> providerClassNames(Collection<MetaDataTypeProvider> providers) {
        return providers.stream()
            .map(p -> p.getClass().getName())
            .collect(Collectors.toSet());
    }

    /**
     * The baseline: a registry constructed with the normal context classloader
     * discovers the real providers. Establishes the expected provider set.
     */
    @Test
    public void defaultRegistryDiscoversProviders() {
        StandardServiceRegistry registry = new StandardServiceRegistry();
        Collection<MetaDataTypeProvider> providers = registry.getServices(MetaDataTypeProvider.class);
        assertFalse("default registry must discover MetaDataTypeProvider services",
            providers.isEmpty());
    }

    /**
     * The fat-jar reproduction: a registry whose captured loader is blind to the
     * provider manifests must STILL discover them via the discovery-time
     * thread-context loader. Pre-fix this returns an empty collection (the bug);
     * post-fix it discovers the full provider set.
     */
    @Test
    public void registryWithBlindCapturedClassLoaderStillDiscoversProviders() {
        // The platform loader cannot see the application classpath, so a
        // ServiceLoader rooted only at it finds nothing — exactly the fat-jar
        // "captured loader can't see nested service manifests" condition.
        ClassLoader blind = ClassLoader.getPlatformClassLoader();
        StandardServiceRegistry registry = new StandardServiceRegistry(blind);

        Collection<MetaDataTypeProvider> providers = registry.getServices(MetaDataTypeProvider.class);

        assertFalse("providers must be discovered even when the captured classloader "
                + "is blind to the service manifests (Spring Boot fat-jar condition)",
            providers.isEmpty());
    }

    /**
     * Discovery must be classloader-independent: the provider set found through a
     * blind captured loader must equal the set found through the normal loader.
     */
    @Test
    public void blindCapturedClassLoaderDiscoversTheSameProviderSet() {
        Set<String> expected = providerClassNames(
            new StandardServiceRegistry().getServices(MetaDataTypeProvider.class));

        Set<String> viaBlind = providerClassNames(
            new StandardServiceRegistry(ClassLoader.getPlatformClassLoader())
                .getServices(MetaDataTypeProvider.class));

        assertEquals("blind-captured-loader discovery must find the same providers "
                + "as normal discovery", expected, viaBlind);
    }

    /**
     * Iterating several classloaders at discovery time must not yield duplicate
     * provider instances of the same concrete class (the captured loader, the
     * thread-context loader, and this class's loader frequently overlap).
     */
    @Test
    public void multiClassLoaderDiscoveryDeduplicatesByConcreteClass() {
        Collection<MetaDataTypeProvider> providers =
            new StandardServiceRegistry().getServices(MetaDataTypeProvider.class);

        Set<String> distinct = providerClassNames(providers);
        assertEquals("each provider class must be registered exactly once",
            distinct.size(), providers.size());
    }

    /**
     * A manually-registered service is an explicit override: when its concrete
     * class is also discoverable via ServiceLoader, the manual instance wins and
     * no duplicate of that class is returned.
     */
    @Test
    public void manuallyRegisteredServiceWinsOverDiscoveredSameClass() {
        StandardServiceRegistry registry = new StandardServiceRegistry();
        CoreTypeMetaDataProvider manual = new CoreTypeMetaDataProvider();
        registry.registerService(MetaDataTypeProvider.class, manual);

        Collection<MetaDataTypeProvider> providers =
            registry.getServices(MetaDataTypeProvider.class);

        long sameClassCount = providers.stream()
            .filter(p -> p.getClass() == CoreTypeMetaDataProvider.class)
            .count();
        assertEquals("exactly one provider of the manually-registered class",
            1, sameClassCount);
        assertTrue("the manual instance must be the one returned (explicit override wins)",
            providers.stream().anyMatch(p -> p == manual));
    }
}
