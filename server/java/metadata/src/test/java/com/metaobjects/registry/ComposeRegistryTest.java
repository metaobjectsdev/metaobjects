package com.metaobjects.registry;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Tests for the programmatic provider-composition API on {@link MetaDataRegistry}.
 *
 * <p>Mirrors the cross-port pattern shipped by the TypeScript port
 * ({@code composeRegistry(providers)}) and the Python port
 * ({@code compose_registry(providers)}). This Java entry point lets callers
 * build a registry by handing it an explicit list of providers — useful for
 * tests, embedded scenarios where ServiceLoader is awkward, and conditional
 * / framework-driven composition.</p>
 */
public class ComposeRegistryTest {

    /** A minimal recording provider that captures the registry it was registered against. */
    static final class RecordingProvider implements MetaDataTypeProvider {
        private final String id;
        private final String[] deps;
        MetaDataRegistry registeredAgainst;

        RecordingProvider(String id, String... deps) {
            this.id = id;
            this.deps = deps;
        }

        @Override
        public String getProviderId() {
            return id;
        }

        @Override
        public String[] getDependencies() {
            return deps;
        }

        @Override
        public void registerTypes(MetaDataRegistry registry) {
            this.registeredAgainst = registry;
        }

        @Override
        public String getDescription() {
            return "recording-provider:" + id;
        }
    }

    /** A provider that records the order it ran in (mutating a shared list). */
    static final class OrderRecordingProvider implements MetaDataTypeProvider {
        private final String id;
        private final String[] deps;
        private final List<String> log;

        OrderRecordingProvider(String id, List<String> log, String... deps) {
            this.id = id;
            this.log = log;
            this.deps = deps;
        }

        @Override
        public String getProviderId() {
            return id;
        }

        @Override
        public String[] getDependencies() {
            return deps;
        }

        @Override
        public void registerTypes(MetaDataRegistry registry) {
            log.add(id);
        }
    }

    @Test
    public void compose_buildsRegistry_andRunsEachProviderAgainstIt() {
        RecordingProvider a = new RecordingProvider("a");
        RecordingProvider b = new RecordingProvider("b");

        MetaDataRegistry registry = MetaDataRegistry.compose(List.of(a, b));

        assertNotNull("compose() should return a non-null registry", registry);
        assertSame("provider a should have registered against the returned registry",
            registry, a.registeredAgainst);
        assertSame("provider b should have registered against the returned registry",
            registry, b.registeredAgainst);
    }

    @Test
    public void compose_runsProvidersInDependencyOrder() {
        List<String> order = new ArrayList<>();
        OrderRecordingProvider a = new OrderRecordingProvider("a", order);
        OrderRecordingProvider b = new OrderRecordingProvider("b", order, "a");
        OrderRecordingProvider c = new OrderRecordingProvider("c", order, "b");

        // Feed in reverse order — topo sort should still produce a, b, c.
        MetaDataRegistry.compose(List.of(c, b, a));

        assertEquals("providers must run in topological order regardless of input order",
            List.of("a", "b", "c"), order);
    }

    @Test
    public void compose_throwsDuplicateId() {
        RecordingProvider dup1 = new RecordingProvider("dup");
        RecordingProvider dup2 = new RecordingProvider("dup");

        try {
            MetaDataRegistry.compose(List.of(dup1, dup2));
            fail("expected MetaDataException with ERR_PROVIDER_DUPLICATE_ID");
        } catch (MetaDataException e) {
            assertEquals(ErrorCode.ERR_PROVIDER_DUPLICATE_ID, e.getCode().orElse(null));
            assertTrue("message should call out the duplicate id",
                e.getMessage().contains("dup"));
        }
    }

    @Test
    public void compose_throwsMissingDependency() {
        RecordingProvider provider = new RecordingProvider("dependent", "absent");

        try {
            MetaDataRegistry.compose(List.of(provider));
            fail("expected MetaDataException with ERR_PROVIDER_MISSING_DEPENDENCY");
        } catch (MetaDataException e) {
            assertEquals(ErrorCode.ERR_PROVIDER_MISSING_DEPENDENCY, e.getCode().orElse(null));
            assertTrue("message should call out the missing dependency id",
                e.getMessage().contains("absent"));
            assertTrue("message should identify the requiring provider",
                e.getMessage().contains("dependent"));
        }
    }

    @Test
    public void compose_throwsDependencyCycle() {
        RecordingProvider a = new RecordingProvider("a", "b");
        RecordingProvider b = new RecordingProvider("b", "a");

        try {
            MetaDataRegistry.compose(List.of(a, b));
            fail("expected MetaDataException with ERR_PROVIDER_DEPENDENCY_CYCLE");
        } catch (MetaDataException e) {
            assertEquals(ErrorCode.ERR_PROVIDER_DEPENDENCY_CYCLE, e.getCode().orElse(null));
        }
    }

    @Test
    public void registerProviders_addsToExistingRegistry() {
        MetaDataRegistry registry = new MetaDataRegistry();
        RecordingProvider added = new RecordingProvider("added");

        registry.registerProviders(List.of(added));

        assertSame("registerProviders should hand the receiving registry to the provider",
            registry, added.registeredAgainst);
    }
}
